import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import { writeFile, rename, unlink } from 'node:fs/promises';
import express from 'express';
import { WebSocket } from 'ws';
import { fixture as memberFixture, record, googleIssuer, config } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createMessageStreamWsRuntime } from './runtime.js';

export const paths = ['/api/global/event/ws', '/api/event/ws?directory=/private'];
export const failures = ['removed', 'mapping-rebound', 'malformed', 'unreadable'];
export const saw = (client, marker) => client.frames.some(frame => frame.payload?.marker === marker || frame.marker === marker);

// Observe actual transport events, with one finite deadline and no polling loop.
export function waitFor(check, emitters, label, timeout = 2500) {
  return new Promise((resolve, reject) => {
    let timer;
    const events = ['message', 'close', 'change'];
    const finish = error => {
      clearTimeout(timer);
      for (const emitter of emitters) for (const event of events) emitter.off(event, inspect);
      if (error) reject(error); else resolve();
    };
    const inspect = () => { if (check()) finish(); };
    for (const emitter of emitters) for (const event of events) emitter.on(event, inspect);
    timer = setTimeout(() => finish(new Error(label)), timeout);
    inspect();
  });
}

export async function fixture() {
  const f = await memberFixture();
  const changes = new EventEmitter(), sockets = [], requests = [], sseClients = new Set();
  const streams = new Set(), wsClients = new Set();
  const effects = { upstream: 0, closed: 0, processed: 0 };
  const data = record();
  data.orgs[0].members.push({ smarty_id: 'sp-other', kind: 'person', status: 'active', role: 'member' });
  data.logins.push({ issuer: googleIssuer, subject: 'other-google-456', smarty_id: 'sp-other' });
  const publish = async value => {
    await writeFile(`${f.path}.next`, JSON.stringify(value));
    await rename(`${f.path}.next`, f.path);
  };
  await publish(data);
  const other = await f.helpers.saveUser(f.helpers.createUser({ name: 'Other', email: 'other@example.test', emailVerified: true }));
  await f.adapter.create({ model: 'account', data: { userId: other.id, providerId: 'google', accountId: 'other-google-456',
    createdAt: new Date(), updatedAt: new Date() } });
  const headers = [f.headers, await f.helpers.getAuthHeaders({ userId: f.user.id }), await f.helpers.getAuthHeaders({ userId: other.id })];
  const sessions = [];
  for (const entry of headers) {
    const session = await f.human.resolve({ headers: Object.fromEntries(entry) });
    assert.ok(session, 'real member admitted');
    sessions.push({ headers: entry, id: session.session.id });
  }
  assert.equal(new Set(sessions.map(session => session.id)).size, 3, 'independent Better Auth sessions');
  const upstream = createServer((_req, res) => {
    effects.upstream++; streams.add(res);
    res.on('close', () => { effects.closed++; streams.delete(res); changes.emit('change'); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': private fixture\n\n');
    changes.emit('change');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const uiAuth = createUiAuth({ humanAuth: f.human });
  const app = express();
  app.use('/api', uiAuth.requireAuth);
  app.use((_req, res, next) => {
    res.once('close', () => queueMicrotask(() => changes.emit('change')));
    next();
  });
  const writeSseEvent = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  registerScheduledTaskRoutes(app, { getOpenChamberEventClients: () => sseClients, writeSseEvent });
  const server = createServer(app);
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const runtime = createMessageStreamWsRuntime({ server, uiAuthController: uiAuth, ...security, wsClients,
    buildOpenCodeUrl: path => `http://127.0.0.1:${upstream.address().port}${path}`,
    getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() { effects.processed++; changes.emit('change'); },
    heartbeatIntervalMs: 60_000, upstreamStallTimeoutMs: 60_000, upstreamReconnectDelayMs: 60_000 });
  runtime.wsServer.on('connection', socket => {
    socket.on('close', () => queueMicrotask(() => changes.emit('change')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const wireHeaders = session => ({ ...Object.fromEntries(session.headers), Host: 'localhost', Origin: config.baseURL });
  const connect = async (path, session) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`, { headers: wireHeaders(session), handshakeTimeout: 2000 });
    sockets.push(socket);
    const client = { socket, frames: [], result: 0 };
    socket.on('message', frame => client.frames.push(JSON.parse(frame.toString())));
    socket.on('error', () => {});
    client.result = await new Promise(resolve => {
      socket.once('open', () => resolve(101)); socket.once('error', () => resolve(0));
      socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
    });
    return client;
  };
  const connectSse = session => new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${server.address().port}/api/openchamber/events`, { headers: wireHeaders(session) }, res => {
      req.setTimeout(0); // Admission has a deadline; a live stream must not expire due to the fixture.
      const client = { socket: res, frames: [], result: res.statusCode };
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (block.startsWith('data: ')) client.frames.push(JSON.parse(block.slice(6)));
        }
        res.emit('change');
      });
      res.on('error', () => {});
      resolve(client);
    });
    requests.push(req); req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('SSE fixture deadline')));
  });
  const withdraw = async failure => {
    const next = structuredClone(data);
    if (failure === 'removed') next.orgs[0].members[0].status = 'removed';
    if (failure === 'mapping-rebound') next.logins[0].smarty_id = 'sp-other';
    if (failure === 'malformed') { await writeFile(`${f.path}.next`, '{broken'); await rename(`${f.path}.next`, f.path); return; }
    if (failure === 'unreadable') { await unlink(f.path); return; }
    await publish(next);
  };
  const emit = marker => {
    for (const res of streams) writeSseEvent(res, { type: 'fixture.event', marker });
    for (const res of sseClients) writeSseEvent(res, { type: 'fixture.event', marker });
  };
  return { ...f, sessions, changes, streams, wsClients, sseClients, runtime, effects, connect, connectSse, withdraw, emit,
    restore: () => publish(data),
    async close() {
      for (const socket of sockets) socket.terminate();
      for (const req of requests) req.destroy();
      await runtime.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
      await f.close();
    } };
}
