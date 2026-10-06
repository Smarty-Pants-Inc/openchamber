import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createHumanAuth } from './human-auth.js';
import { createUiAuth } from './ui-auth.js';
import { configureApplicationHosts } from '../security/browser-origin.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createMessageStreamWsRuntime } from '../event-stream/runtime.js';
import { createDictationRuntime } from '../dictation/runtime.js';
import { createDevTunnelRuntime } from '../dev-tunnel/runtime.js';
import { attachRealtimeProxy } from '../realtime-proxy.js';
import { attachSessionVoiceSocket } from '../opencode/session-voice-socket.js';

const issuer = 'https://code.smartypants.ai';
const aliases = 'code.smartypants.ai,smartypants.smartypants.ai';
const hostReason = 'Requests require an application host';

async function humanFixture() {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ database, baseURL: issuer,
    secret: 'fixture-only-secret-at-least-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  // Official test helpers seed a real private session, never a protected identity or permission stub.
  const testAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await testAuth.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ name: 'Person', email: 'person@example.test', emailVerified: true }));
  const headers = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id }));
  return { human, headers, controller: createUiAuth({ humanAuth: human }),
    close() { human.dispose(); database.close(); } };
}

function configureHosts() {
  const previous = process.env.OPENCHAMBER_ALLOWED_HOSTS;
  process.env.OPENCHAMBER_ALLOWED_HOSTS = aliases;
  configureApplicationHosts(async () => (process.env.OPENCHAMBER_ALLOWED_HOSTS ?? '').split(','));
  return () => {
    if (previous === undefined) delete process.env.OPENCHAMBER_ALLOWED_HOSTS;
    else process.env.OPENCHAMBER_ALLOWED_HOSTS = previous;
    configureApplicationHosts(async () => []);
  };
}

async function admission(controller, headers) {
  const socket = new Socket();
  let result = 'admitted';
  try {
    await controller.requireUpgradeAuth({ headers }, socket, () => {}, (_socket, code, reason) => { result = { code, reason }; });
    return result;
  } finally { socket.destroy(); }
}

test('central human upgrade adds Host authority without changing issuer Origin or session requirements', async () => {
  const f = await humanFixture(), restore = configureHosts();
  try {
    const headers = { ...f.headers, origin: issuer, host: 'test-org.smartypants.ai' };
    assert.deepEqual(await admission(f.controller, headers), { code: 403, reason: hostReason });
    assert.deepEqual(await admission(f.controller, { ...headers, 'x-forwarded-host': 'code.smartypants.ai', forwarded: 'host=code.smartypants.ai' }),
      { code: 403, reason: hostReason });
    delete process.env.OPENCHAMBER_ALLOWED_HOSTS;
    assert.deepEqual(await admission(f.controller, { ...headers, host: 'code.smartypants.ai' }), { code: 403, reason: hostReason });
    process.env.OPENCHAMBER_ALLOWED_HOSTS = aliases;
    for (const host of [...aliases.split(','), 'localhost:43210', '127.0.0.1:43210', '[::1]:43210', '192.0.2.1:43210']) {
      assert.equal(await admission(f.controller, { ...headers, host }), 'admitted');
      assert.deepEqual(await admission(f.controller, { host, origin: issuer }), { code: 401, reason: 'Human authentication required' });
      for (const origin of ['https://smartypants.smartypants.ai', 'https://attacker.test', 'null', undefined]) {
        assert.deepEqual(await admission(f.controller, { ...headers, host, origin }), { code: 403, reason: 'Invalid origin' });
      }
    }
  } finally { restore(); f.close(); }
});

async function runtimeFixture(f) {
  const effects = { tcp: 0, streams: 0, sockets: 0, gateway: 0, discovery: 0 };
  const upstream = createServer((_req, res) => {
    effects.streams++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': private fixture\n\n');
  });
  upstream.on('connection', () => { effects.tcp++; });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', (socket) => { effects.sockets++; socket.on('error', () => {}); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const base = `http://127.0.0.1:${upstreamPort}`;
  const app = express(), server = createServer(app);
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: issuer }) });
  const shared = { server, app, uiAuthController: f.controller, ...security };
  const events = createMessageStreamWsRuntime({ ...shared, buildOpenCodeUrl: p => `${base}${p}`,
    getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() {}, wsClients: new Set(), upstreamReconnectDelayMs: 60_000 });
  const dictation = createDictationRuntime({ ...shared, express, modelsDir: '/unused-private-upgrade-fixture' });
  const tunnel = createDevTunnelRuntime({ ...shared, discoverDevServers: async () => {
    effects.discovery++; return { ok: true, servers: [{ port: upstreamPort }] };
  } });
  const proxy = attachRealtimeProxy({ ...shared, getUiAuthController: () => f.controller,
    getDesktopRuntimeConfig: () => ({ apiBaseUrl: base, requestHeaders: { 'x-private-fixture': 'true' } }) });
  const voice = attachSessionVoiceSocket({ ...shared, getUiAuthController: () => f.controller,
    buildOpenCodeUrl: p => { effects.gateway++; return `${base}${p}`; },
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer private-fixture-only' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const paths = ['/api/global/event/ws', '/api/event/ws?directory=/private', '/api/dictation/ws',
    `/api/dev-tunnel?port=${upstreamPort}`, `/api/openchamber/realtime-proxy/ws?url=${encodeURIComponent(`ws://127.0.0.1:${upstreamPort}/api/global/event/ws`)}`,
    '/api/session/private-fixture/voice/socket?directory=/private'];
  const open = (path, headers) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, handshakeTimeout: 3000 });
    socket.once('open', () => { socket.close(); resolve({ code: 101 }); });
    socket.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.once('end', () => { socket.terminate(); resolve({ code: res.statusCode, reason: body || res.statusMessage }); });
    });
    socket.on('error', reject);
  });
  return { effects, paths, open, async close() {
    voice.stop(); proxy.stop(); tunnel.dispose(); dictation.stop();
    await events.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const socket of upstreamWs.clients) socket.terminate();
    await new Promise(resolve => upstreamWs.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  } };
}

for (const index of [0, 2]) test(`raw human WS control ${index}: served aliases and loopback keep session and Origin rules`, async () => {
  const f = await humanFixture(), restore = configureHosts();
  const runtime = await runtimeFixture(f);
  try {
    for (const Host of [...aliases.split(','), '127.0.0.1', 'localhost']) {
      assert.equal((await runtime.open(runtime.paths[index], { ...f.headers, Host, Origin: issuer })).code, 101);
      assert.equal((await runtime.open(runtime.paths[index], { Host, Origin: issuer })).code, 401);
      assert.equal((await runtime.open(runtime.paths[index], { ...f.headers, Host, Origin: 'https://attacker.test' })).code, 403);
    }
  } finally { await runtime.close(); restore(); f.close(); }
});

for (let index = 0; index < 6; index++) test(`raw human WS ingress ${index}: unbound Host cannot set up capability; served hosts still work`, async () => {
  const f = await humanFixture(), restore = configureHosts();
  const runtime = await runtimeFixture(f);
  try {
    const path = runtime.paths[index];
    const headers = { ...f.headers, Origin: issuer, Host: 'test-org.smartypants.ai' };
    for (const extra of [{}, { 'X-Forwarded-Host': 'code.smartypants.ai', Forwarded: 'host=code.smartypants.ai' }]) {
      assert.deepEqual(await runtime.open(path, { ...headers, ...extra }), { code: 403, reason: hostReason }, path);
    }
    const invalidPaths = index === 3 ? ['/api/dev-tunnel', '/api/dev-tunnel?port=bad', '/api/dev-tunnel?port=1']
      : index === 4 ? ['/api/openchamber/realtime-proxy/ws', '/api/openchamber/realtime-proxy/ws?url=bad']
      : index === 5 ? ['/api/session/private-fixture/voice/socket', '/api/session/%ZZ/voice/socket?directory=/private']
      : index === 1 ? ['/api/event/ws', '/api/event/ws?directory='] : [];
    for (const requestPath of [path, ...invalidPaths]) {
      for (const session of [f.headers, {}]) {
        for (const Origin of [issuer, 'https://attacker.test', 'null', undefined]) {
          const requestHeaders = { ...session, Host: headers.Host };
          if (Origin !== undefined) requestHeaders.Origin = Origin;
          assert.deepEqual(await runtime.open(requestPath, requestHeaders), { code: 403, reason: hostReason }, requestPath);
        }
      }
    }
    assert.deepEqual(runtime.effects, { tcp: 0, streams: 0, sockets: 0, gateway: 0, discovery: 0 });
    if ([3, 4, 5].includes(index)) {
      configureApplicationHosts(async () => null); // Fault injection at Host configuration, not human identity.
      assert.deepEqual(await runtime.open(path, headers), index === 4
        ? { code: 401, reason: 'Unauthorized' } : { code: 500, reason: 'Upgrade failed' });
      assert.deepEqual(runtime.effects, { tcp: 0, streams: 0, sockets: 0, gateway: 0, discovery: 0 });
      configureApplicationHosts(async () => (process.env.OPENCHAMBER_ALLOWED_HOSTS ?? '').split(','));
    }
    for (const host of [...aliases.split(','), '127.0.0.1', 'localhost']) {
      assert.equal((await runtime.open(path, { ...headers, Host: host })).code, 101, path);
      assert.equal((await runtime.open(path, { Origin: issuer, Host: host })).code, 401, path);
      for (const Origin of ['https://attacker.test', 'null']) {
        assert.equal((await runtime.open(path, { ...headers, Host: host, Origin })).code, 403, path);
      }
      if (index === 3 || index === 5) {
        for (const invalidPath of invalidPaths) {
          const reason = index === 5 ? 'Voice needs a session and a project directory'
            : invalidPath.endsWith('port=1') ? 'That port is not an available dev server' : 'Invalid port';
          assert.deepEqual(await runtime.open(invalidPath, { ...headers, Host: host }),
            { code: reason === 'That port is not an available dev server' ? 403 : 400, reason }, invalidPath);
        }
      }
    }
  } finally { await runtime.close(); restore(); f.close(); }
});
