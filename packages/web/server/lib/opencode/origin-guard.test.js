import assert from 'node:assert/strict';
import { test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

// smarty-code#391: in the passwordless loopback mode (no human auth, no UI password), any page in the same browser, a
// sandboxed preview among them, could POST to the application's mutations. A browser's mutation now needs this server's
// own origin or a native client's, and every request needs an application host (below: reads).
test('passwordless loopback: browser mutations need the application origin; native clients and GETs pass', async () => {
  let shutdowns = 0;
  const app = express();
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { tunnelAuthController: tunnel, process, runtimeName: 'test', openchamberVersion: 'fixture',
    sessionRuntime: {}, gracefulShutdown: async () => { shutdowns++; }, getHealthSnapshot: () => ({}) });
  const writes = [];
  app.post('/api/fs/write', (req, res) => { writes.push(req.body); res.json({ ok: true }); });
  const form = (origin, site) => {
    const call = request(app).post('/api/fs/write').type('form').send({ path: '/tmp/x', content: 'changed' });
    if (origin !== undefined) call.set('Origin', origin);
    if (site !== undefined) call.set('Sec-Fetch-Site', site);
    return call;
  };
  await form('null', 'cross-site').expect(403); // A sandboxed (opaque) page.
  await form('https://attacker.test', 'cross-site').expect(403); // Another site.
  await form(undefined, 'cross-site').expect(403); // A browser that sent no Origin.
  await request(app).post('/api/system/shutdown').set('Origin', 'null').expect(403);
  assert.deepEqual(writes, []); assert.equal(shutdowns, 0);
  await form(undefined, 'same-origin').expect(403); // A browser mutation always says its Origin; metadata alone is not enough.
  const self = request(app).post('/api/fs/write'); // Origin equal to the server's own (browsers without Sec-Fetch-Site).
  await self.set('Origin', new URL(self.url).origin).type('form').send({ path: '/tmp/x', content: 'self' }).expect(200);
  await form('openchamber-ui://app').expect(200); // The packaged desktop client.
  await form('vscode-webview://abc123').expect(200); // The VS Code webview.
  await form().expect(200); // No browser: a CLI or native bridge.
  assert.equal(writes.length, 4);
  await request(app).get('/api/system/info').set('Origin', 'null').expect((res) => assert.notEqual(res.status, 403));
  // DNS rebinding (security pass on #271): an attacker's hostname pointed at this listener is same-origin to the browser.
  const rebound = () => request(app).post('/api/fs/write').type('form').set('Host', 'attacker.test:4001')
    .set('Origin', 'http://attacker.test:4001').set('Sec-Fetch-Site', 'same-origin').send({ path: '/tmp/x', content: 'rebound' });
  await rebound().expect(403);
  await rebound().set('X-Forwarded-Host', 'localhost').expect(403); // A page can set a forwarding header: never trusted.
  await rebound().set('X-Forwarded-Host', '127.0.0.1').set('Forwarded', 'host=localhost').expect(403);
  await request(app).post('/api/fs/write').type('form').set('Host', 'mac.local:4001').set('Origin', 'http://mac.local:4001')
    .send({ path: '/tmp/x', content: 'lan' }).expect(403); // A LAN name that is not configured.
  process.env.OPENCHAMBER_ALLOWED_HOSTS = 'mac.local';
  try {
    await request(app).post('/api/fs/write').type('form').set('Host', 'mac.local:4001').set('Origin', 'http://mac.local:4001')
      .send({ path: '/tmp/x', content: 'lan' }).expect(200); // Configured: the application's host.
  } finally { delete process.env.OPENCHAMBER_ALLOWED_HOSTS; }
  await request(app).post('/api/fs/write').type('form').set('Host', '192.168.1.5:4001').set('Origin', 'http://192.168.1.5:4001')
    .send({ path: '/tmp/x', content: 'ip' }).expect(200); // An IP address cannot be rebound to.
  assert.equal(writes.length, 6);
});

// Security pass 2 on #271: a rebound hostname could still READ (every GET was exempt from the host check), and a
// client-supplied X-Forwarded-Host stood in for the real Host. Every passwordless request now needs its own Host to be the
// application's; forwarding headers are never used. The preview capability is its own credential, as before.
test('passwordless reads need an application host: a rebound Host reads nothing, with or without Origin or forwarding headers', async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { registerFsRoutes } = await import('../fs/routes.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-rebind-read-')));
  const secret = path.join(root, 'secret.txt');
  await fs.writeFile(secret, 'workspace secret');
  const app = express();
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { tunnelAuthController: tunnel, process, runtimeName: 'test', openchamberVersion: 'fixture',
    sessionRuntime: {}, gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  registerFsRoutes(app, { os, path, fsPromises: fs, spawn: () => { throw new Error('unused'); }, crypto: { randomUUID: () => 'id-0' },
    normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: root }),
    resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, '.config') });
  try {
    const read = (host) => request(app).get(`/api/fs/read?path=${encodeURIComponent(secret)}`).set('Host', host);
    const refused = (res) => { assert.equal(res.status, 403); assert.ok(!JSON.stringify(res.body).includes('workspace secret')); };
    await read('attacker.test:4001').expect(refused); // No Origin, no fetch metadata.
    await read('attacker.test:4001').set('Origin', 'http://attacker.test:4001').set('Sec-Fetch-Site', 'same-origin').expect(refused);
    await read('attacker.test:4001').set('X-Forwarded-Host', 'localhost').set('Sec-Fetch-Site', 'same-origin').expect(refused);
    await request(app).get('/api/system/info').set('Host', 'attacker.test:4001').expect(403); // A representative API read.
    const text = (res) => JSON.stringify(res.body) + (res.text ?? '');
    assert.ok(text(await read('127.0.0.1:4001').expect(200)).includes('workspace secret')); // Loopback: the application.
    assert.ok(text(await read('localhost:4001').expect(200)).includes('workspace secret'));
    process.env.OPENCHAMBER_ALLOWED_HOSTS = 'code.example.test';
    try { assert.ok(text(await read('code.example.test').expect(200)).includes('workspace secret')); } // Configured.
    finally { delete process.env.OPENCHAMBER_ALLOWED_HOSTS; }
    // The preview capability (registered before the host check) is its own credential and still serves its frame.
    const grant = await request(app).post('/api/fs/preview').set('Host', '127.0.0.1:4001').set('Origin', 'http://127.0.0.1:4001')
      .send({ path: secret }).expect(200);
    await request(app).get(new URL(grant.body.url, 'http://127.0.0.1').pathname).set('Host', '127.0.0.1:4001').expect(200);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('passwordless WebSocket upgrades (event stream, terminal) refuse opaque, other and rebound origins', async () => {
  const { createServer } = await import('node:http');
  const { WebSocket } = await import('ws');
  const { createMessageStreamWsRuntime } = await import('../event-stream/runtime.js');
  const { createTerminalRuntime } = await import('../terminal/runtime.js');
  const { createRequestSecurityRuntime } = await import('../security/request-security.js');
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const server = createServer((_req, res) => res.end());
  const events = createMessageStreamWsRuntime({ server, uiAuthController: null, isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade, buildOpenCodeUrl: (p) => `http://127.0.0.1:9${p}`, getOpenCodeAuthHeaders: () => ({}),
    processForwardedEventPayload() {}, wsClients: new Set(), upstreamReconnectDelayMs: 60_000,
    fetchImpl: () => new Promise(() => {}) });
  const terminal = createTerminalRuntime({ app: { get() {}, post() {}, delete() {} }, server, fs: {}, path: {}, uiAuthController: null,
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false, isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    loadPtyProvider: async () => { throw new Error('unused'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const open = (path, headers) => new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_req, res) => { resolve(res.statusCode); socket.terminate(); });
    socket.once('error', () => resolve('error'));
  });
  try {
    for (const path of ['/api/global/event/ws', '/api/terminal/ws']) {
      assert.equal(await open(path, { Origin: 'null' }), 403, path); // A sandboxed preview.
      assert.equal(await open(path, { Origin: 'https://attacker.test' }), 403, path);
      assert.equal(await open(path, { Host: 'attacker.test', Origin: 'http://attacker.test' }), 403, path); // Rebound.
      assert.equal(await open(path, { Origin: `http://127.0.0.1:${port}` }), 'open', path); // The application's page.
      assert.equal(await open(path, { Origin: 'openchamber-ui://app' }), 'open', path); // The desktop client.
      assert.equal(await open(path, {}), 'open', path); // Not a browser.
    }
  } finally {
    await events.stop?.(); await terminal.shutdown?.(); await terminal.stop?.();
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
  }
});
