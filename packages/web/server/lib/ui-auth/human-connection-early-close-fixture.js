import express from 'express';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { fixture, config, record, googleIssuer } from './human-member-fixture.js';
import { createUiAuth } from './ui-auth.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Observe only lifetime-owned real timers. Better Auth and Node keep their normal clocks.
function observeLifetimeTimers() {
  const originals = { setTimeout, clearTimeout, setInterval, clearInterval };
  const expiry = new Set(), watchers = new Set();
  const owned = () => new Error().stack.includes('/human-connection.js:');
  globalThis.setTimeout = (callback, delay, ...args) => {
    const track = owned();
    const timer = originals.setTimeout((...values) => { expiry.delete(timer); callback(...values); }, delay, ...args);
    if (track) expiry.add(timer);
    return timer;
  };
  globalThis.setInterval = (...args) => {
    const track = owned(), timer = originals.setInterval(...args);
    if (track) watchers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { expiry.delete(timer); return originals.clearTimeout(timer); };
  globalThis.clearInterval = timer => { watchers.delete(timer); return originals.clearInterval(timer); };
  return { expiry, watchers, restore() { Object.assign(globalThis, originals); } };
}

export async function earlyCloseFixture({ configured = true, lookup = 1, failLookup = false, earlyEnding = null } = {}) {
  const f = await fixture({ configured });
  const timers = observeLifetimeTimers();
  const sampled = deferred(), release = deferred(), settled = deferred(), closed = deferred(), captured = deferred();
  const originalSession = f.human.auth.api.getSession, originalProtect = f.human.protect;
  const originalFind = f.adapter.findMany;
  let reads = 0, accountReads = 0, downstream = 0, req, transport, baseline;
  f.adapter.findMany = async (...args) => {
    if (args[0].model === 'account') accountReads++;
    return originalFind(...args);
  };
  f.human.auth.api.getSession = async (...args) => {
    const session = await originalSession(...args);
    if (++reads === lookup) {
      sampled.resolve(); await release.promise;
      if (failLookup) throw new Error('private fixture lookup failure');
    }
    return session;
  };
  f.human.protect = async (...args) => {
    try { return await originalProtect(...args); }
    finally { settled.resolve(); }
  };
  const capture = (request, response) => {
    req = request; transport = response;
    response.once('close', closed.resolve);
    response.on('error', () => {});
    baseline = { close: response.listenerCount('close') - 1, finish: response.listenerCount('finish') };
    captured.resolve();
  };
  const app = express();
  app.use((request, response, next) => {
    capture(request, response);
    if (earlyEnding === 'ended') response.end();
    if (earlyEnding === 'destroyed') response.destroy();
    next();
  });
  const tunnel = createTunnelAuth();
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes() {},
    registerNotificationRoutes() {}, registerOpenChamberRoutes() {},
  }).setupBaseRoutes(app, { humanAuth: f.human, tunnelAuthController: tunnel, process, sessionRuntime: {},
    gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  app.get('/api/early-close', (request, response) => {
    downstream++; response.status(200);
    if (request.query.live) response.write('admitted'); else response.end('admitted');
  });
  const server = createServer(app), sockets = new Set(), clients = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    capture(request, socket);
    socket.resume();
    void uiAuthController.requireUpgradeAuth(request, socket, () => {
      downstream++; socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    }, (connection, status) => connection.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const connect = async (kind, { live = false, headers = f.headers } = {}) => {
    if (kind === 'http') {
      const client = httpRequest({ host: '127.0.0.1', port, path: `/api/early-close${live ? '?live=1' : ''}`,
        headers: { ...Object.fromEntries(headers), Host: 'localhost:43210' } });
      clients.add(client); client.on('error', () => {});
      const result = new Promise(done => client.on('response', response => {
        response.resume(); done(response.statusCode);
      }));
      client.end(); return { client, result };
    }
    const client = createConnection({ host: '127.0.0.1', port });
    clients.add(client); client.on('error', () => {});
    await once(client, 'connect');
    const result = new Promise(done => client.once('data', data => done(Number(data.toString().split(' ')[1]))));
    client.write(`GET /api/early-close HTTP/1.1\r\nHost: localhost:43210\r\nOrigin: ${config.baseURL}\r\nCookie: ${headers.get('cookie')}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    return { client, result };
  };
  const unrelatedHeaders = async () => {
    const user = await f.helpers.saveUser(f.helpers.createUser({ name: 'Other', email: 'other@example.test', emailVerified: true }));
    await f.adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: 'other-google',
      createdAt: new Date(), updatedAt: new Date() } });
    const data = record();
    data.orgs[0].members.push({ smarty_id: 'other-person', kind: 'person', status: 'active', role: 'member' });
    data.logins.push({ issuer: googleIssuer, subject: 'other-google', smarty_id: 'other-person' });
    await f.publish(data);
    return f.helpers.getAuthHeaders({ userId: user.id });
  };
  return { ...f, timers, sampled, release, settled, closed, captured, connect, unrelatedHeaders,
    get req() { return req; }, get transport() { return transport; }, get baseline() { return baseline; },
    get downstream() { return downstream; }, get accountReads() { return accountReads; },
    async close() {
      release.resolve();
      for (const client of clients) client.destroy();
      f.human.dispose();
      const socketClosures = [...sockets].map(socket => new Promise(done => {
        socket.once('close', done); socket.destroy();
      }));
      try {
        if (reads) await settled.promise;
        await Promise.all(socketClosures);
        await new Promise(done => server.close(done));
        assert.equal(sockets.size, 0, 'all owned server sockets closed');
        assert.equal(timers.expiry.size, 0, 'disposal retires even RED expiry leaks');
        assert.equal(timers.watchers.size, 0, 'disposal stops even RED membership watchers');
      } finally {
        f.human.auth.api.getSession = originalSession; f.human.protect = originalProtect;
        f.adapter.findMany = originalFind;
        uiAuthController.dispose(); tunnel.dispose?.();
        try { await f.close(); } finally { timers.restore(); }
      }
    } };
}
