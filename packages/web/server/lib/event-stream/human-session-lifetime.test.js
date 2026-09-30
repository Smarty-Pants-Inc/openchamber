import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { WebSocket } from 'ws';
import { createHumanAuth } from '../ui-auth/human-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { configureApplicationHosts } from '../security/browser-origin.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createMessageStreamWsRuntime } from './runtime.js';

const issuer = 'https://code.smartypants.ai';
const paths = ['/api/global/event/ws', '/api/event/ws?directory=/private'];
async function until(check, label, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), label);
}
async function fixture(uiAuthController = null) {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ database, baseURL: issuer,
    secret: 'fixture-only-secret-at-least-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  const testAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await testAuth.$context).test;
  const people = await Promise.all(['first', 'other'].map(name => helpers.saveUser(helpers.createUser({
    name, email: `${name}@example.test`, emailVerified: true,
  }))));
  const sessions = [];
  for (const user of [people[0], people[0], people[1]]) {
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const resolved = await human.resolve({ headers: Object.fromEntries(headers) });
    sessions.push({ headers, id: resolved.session.id });
  }
  const streams = new Set(), clients = [], wsClients = new Set();
  const effects = { upstream: 0, closed: 0, processed: 0, admitted: 0 };
  const upstream = createServer((_req, res) => {
    effects.upstream++; streams.add(res);
    res.on('close', () => { effects.closed++; streams.delete(res); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': private fixture\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const server = createServer();
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: issuer }) });
  const runtime = createMessageStreamWsRuntime({ server, uiAuthController: uiAuthController ?? createUiAuth({ humanAuth: human }), ...security,
    buildOpenCodeUrl: path => `http://127.0.0.1:${upstream.address().port}${path}`,
    getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() { effects.processed++; }, wsClients,
    heartbeatIntervalMs: 60_000, upstreamStallTimeoutMs: 60_000, upstreamReconnectDelayMs: 60_000 });
  runtime.wsServer.on('connection', () => { effects.admitted++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  configureApplicationHosts(async () => ['code.smartypants.ai']);
  const connect = async (path, session, extra = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`, {
      headers: { ...Object.fromEntries(session.headers), Host: 'code.smartypants.ai', Origin: issuer, ...extra },
      handshakeTimeout: 2000,
    });
    const frames = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    socket.on('error', () => {});
    clients.push(socket);
    const result = await new Promise(resolve => {
      socket.once('open', () => resolve(101));
      socket.once('error', () => resolve(0));
      socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
    });
    return { socket, frames, result };
  };
  const emit = marker => {
    for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'fixture.event', marker })}\n\n`);
  };
  return { database, human, sessions, effects, streams, wsClients, runtime, connect, emit, async close() {
    for (const socket of clients) socket.terminate();
    await runtime.close(); human.dispose(); uiAuthController?.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    configureApplicationHosts(async () => []); database.close();
  } };
}
const saw = (client, marker) => client.frames.some(frame => frame.payload?.marker === marker);

for (const path of paths) test(`${path}: passwordless admission retains browser-origin gate`, async () => {
  const f = await fixture(createUiAuth({}));
  try {
    const anonymous = { headers: new Headers() };
    assert.equal((await f.connect(path, anonymous, { Origin: 'https://attacker.test' })).result, 403);
    assert.equal(f.effects.upstream, 0);
    const client = await f.connect(path, anonymous);
    assert.equal(client.result, 101);
    await until(() => client.frames.some(frame => frame.type === 'ready'), 'passwordless stream ready');
    f.emit('passwordless'); await until(() => saw(client, 'passwordless'), 'passwordless delivery');
  } finally { await f.close(); }
});

for (const path of paths) for (const end of ['signOut', 'revokeOtherSessions', 'expiry']) {
  test(`${path}: ${end} stops delivery and isolates healthy sessions`, async () => {
    const f = await fixture();
    try {
      if (end === 'expiry') {
        // Supported Better Auth option prevents sliding renewal of this short private DB lifetime.
        f.human.auth.options.session.disableSessionRefresh = true;
        f.database.prepare('UPDATE session SET expiresAt = ? WHERE id = ?').run(Date.now() + 1800, f.sessions[0].id);
      }
      const clients = [];
      for (const session of f.sessions) clients.push(await f.connect(path, session));
      assert.deepEqual(clients.map(client => client.result), [101, 101, 101]);
      await until(() => clients.every(client => client.frames.some(frame => frame.type === 'ready')), 'all streams ready');
      f.emit('before'); await until(() => clients.every(client => saw(client, 'before')), 'all receive before end');
      assert.equal(f.effects.processed, path === paths[0] ? 1 : 3);
      if (end === 'signOut') await f.human.auth.api.signOut({ headers: f.sessions[0].headers });
      if (end === 'revokeOtherSessions') await f.human.auth.api.revokeOtherSessions({ headers: f.sessions[1].headers });
      // Send after the authoritative session ends, even on RED, to expose retained delivery.
      if (end === 'expiry') await until(() => f.database.prepare('SELECT expiresAt FROM session WHERE id = ?')
        .get(f.sessions[0].id).expiresAt <= Date.now(), 'private session expired', 2500);
      await delay(50); f.emit('after');
      await until(() => clients.slice(1).every(client => saw(client, 'after')), 'other device and person remain live');
      assert.equal(saw(clients[0], 'after'), false, 'ended session received private event');
      await until(() => clients[0].socket.readyState === WebSocket.CLOSED, 'ended socket closes');
      await until(() => f.runtime.wsServer.clients.size === 2, 'only healthy sockets remain registered');
      assert.equal(f.wsClients.size, path === paths[0] ? 2 : 0);
      assert.equal(await f.human.resolve({ headers: Object.fromEntries(f.sessions[0].headers) }), null);
      assert.equal((await f.connect(path, f.sessions[0])).result, 401);
      const remaining = path === paths[0] ? 1 : 2;
      await until(() => f.streams.size === remaining, 'only healthy upstream readers remain');
      assert.equal(f.effects.upstream, path === paths[0] ? 1 : 3);
      assert.equal(f.effects.closed, path === paths[0] ? 0 : 1);
      for (const client of clients.slice(1)) client.socket.close();
      await until(() => f.runtime.wsServer.clients.size === 0 && f.streams.size === 0, 'last close stops upstream');
      assert.equal(f.effects.closed, f.effects.upstream);
      assert.equal(f.effects.processed, path === paths[0] ? 2 : 5);
      const processed = f.effects.processed, upstream = f.effects.upstream;
      f.emit('stopped'); await delay(80);
      assert.equal(f.effects.processed, processed); assert.equal(f.effects.upstream, upstream);
    } finally { await f.close(); }
  });
}

for (const path of paths) for (const heldRead of [1, 2]) {
  test(`${path}: deletion during admission read ${heldRead} never upgrades`, async () => {
    const f = await fixture();
    const original = f.human.auth.api.getSession;
    let release, sampled = false, reads = 0;
    const pause = new Promise(resolve => { release = resolve; });
    try {
      // Pause a real authoritative read, not its result or identity/permission policy.
      f.human.auth.api.getSession = async (...args) => {
        const session = await original(...args);
        if (++reads === heldRead) { sampled = true; await pause; }
        return session;
      };
      const pending = f.connect(path, f.sessions[0]);
      try {
        await until(() => sampled, 'admission reaches authoritative recheck');
        await f.human.auth.api.signOut({ headers: f.sessions[0].headers });
      } finally { release(); }
      const client = await pending;
      assert.notEqual(client.result, 101, 'deleted session upgraded');
      assert.equal(f.effects.admitted, 0); assert.equal(f.effects.upstream, 0);
      assert.equal(f.wsClients.size, 0);
      f.human.auth.api.getSession = original;
      const healthy = await f.connect(path, f.sessions[2]);
      assert.equal(healthy.result, 101);
      await until(() => healthy.frames.some(frame => frame.type === 'ready'), 'healthy admission after race');
      f.emit('healthy'); await until(() => saw(healthy, 'healthy'), 'healthy person receives');
    } finally { release(); f.human.auth.api.getSession = original; await f.close(); }
  });
}

for (const path of paths) test(`${path}: Host-first denial, exact Origin and healthy admission`, async () => {
  const f = await fixture();
  try {
    for (const session of [f.sessions[0], { headers: new Headers() }]) {
      for (const Origin of [issuer, 'https://attacker.test']) {
        assert.equal((await f.connect(path, session, { Host: 'unbound.example.test', Origin,
          'X-Forwarded-Host': 'code.smartypants.ai' })).result, 403);
      }
    }
    assert.equal((await f.connect(path, f.sessions[0], { Origin: 'https://attacker.test' })).result, 403);
    assert.equal((await f.connect(path, { headers: new Headers() })).result, 401);
    assert.equal(f.effects.admitted, 0); assert.equal(f.effects.upstream, 0);
    const healthy = await f.connect(path, f.sessions[0]);
    assert.equal(healthy.result, 101);
    await until(() => healthy.frames.some(frame => frame.type === 'ready'), 'healthy stream ready');
    f.emit('control'); await until(() => saw(healthy, 'control'), 'healthy session delivery');
  } finally { await f.close(); }
});
