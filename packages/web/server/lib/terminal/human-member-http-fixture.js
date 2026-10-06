import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import express from 'express';
import { WebSocket } from 'ws';
import { fixture, config, record } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTerminalRuntime } from './runtime.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { deferred, until } from './human-member-fixture.js';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from './terminal-ws-protocol.js';

export async function bounded(promise, label = 'HTTP fixture barrier') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3500);
    })]);
  } finally { clearTimeout(timer); }
}

export function barrier() {
  const entered = deferred(), release = deferred();
  return { entered: entered.promise, release: release.resolve,
    async hold() { entered.resolve(); await bounded(release.promise, 'release'); } };
}

export async function httpFixture(options = {}) {
  const f = await fixture(options), app = express(), server = createServer(app);
  const controller = createUiAuth({ humanAuth: f.human });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: config.baseURL }) });
  const spawns = [], signals = [], requests = [], peers = new Set(), holds = new Set();
  let preparation = null, spawnBehavior = null, startupOutput = '';
  const makePty = () => {
    let output;
    const exits = new Set();
    const pty = { pid: 987654321, writes: [], kills: [],
      write(data) { pty.writes.push(data); }, resize() {},
      kill(signal) { pty.kills.push(signal); for (const exit of [...exits]) exit({ exitCode: 0 }); },
      onData(callback) { output = callback; if (startupOutput) callback(startupOutput); },
      onExit(callback) { exits.add(callback); return { dispose: () => exits.delete(callback) }; },
      output(data) { output(data); } };
    return pty;
  };
  const waitPreparation = async stage => {
    if (preparation?.stage !== stage) return;
    const held = preparation; preparation = null; await held.gate.hold();
  };
  const filesystem = { ...fs, promises: { ...fs.promises,
    async stat(...args) { await waitPreparation('stat'); return fs.promises.stat(...args); },
    async readFile(...args) { await waitPreparation('shell'); return fs.promises.readFile(...args); } } };
  app.use(express.json());
  registerAuthAndAccessRoutes(app, { express, uiAuthController: controller, tunnelAuthController: createTunnelAuth() });
  // Observe completion of the registered production coroutine, not merely a closed response.
  const registerPost = app.post.bind(app);
  app.post = (route, handler) => registerPost(route, (req, res, next) => {
    const finished = deferred();
    const observation = { req, res, finished: finished.promise };
    requests.push(observation);
    try {
      return Promise.resolve(handler(req, res, next)).finally(finished.resolve);
    } catch (error) { finished.resolve(); throw error; }
  });
  const runtime = createTerminalRuntime({ app, server, fs: filesystem, path, uiAuthController: controller, ...security,
    buildAugmentedPath: () => process.env.PATH || '', searchPathFor: name => `/fixture/${name}`,
    isExecutable: () => true, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    signalProcess: (pid, signal) => signals.push({ pid, signal }), terminalTerminationGraceMs: 10,
    loadPtyProvider: async () => {
      await waitPreparation('provider');
      return { backend: 'inert-http-fixture', spawn: async (executable, args, launch) => {
        const pty = makePty();
        spawns.push({ executable, args, cwd: launch.cwd, cols: launch.cols, rows: launch.rows, pty });
        return spawnBehavior ? spawnBehavior(pty, spawns.length) : pty;
      } };
    } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}, headers = f.headers) => {
    const result = fetch(`${base}${route}`, { method: 'POST', headers: {
      ...Object.fromEntries(headers), 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      .then(async response => ({ status: response.status, body: await response.json() }), error => ({ error }));
    return result;
  };
  const create = (body = {}, headers) => post('/api/terminal/create', {
    sessionId: 'http-terminal', cwd: path.dirname(f.path), shell: 'sh', ...body }, headers);
  const observe = async index => {
    await until(() => requests.length > index); return requests[index];
  };
  const prepare = stage => {
    const gate = barrier(); holds.add(gate); preparation = { stage, gate }; return gate;
  };
  const withdraw = async mutation => {
    if (mutation === 'malformed') return writeFile(f.path, '{broken');
    if (mutation === 'missing') return unlink(f.path);
    const data = record();
    if (mutation === 'remapped') {
      data.orgs[0].members[0].smarty_id = 'replacement-person'; data.logins[0].smarty_id = 'replacement-person';
    } else if (mutation === 'removed') data.orgs[0].members = [];
    else data.orgs[0].members[0].status = mutation;
    await f.publish(data);
  };
  const snapshot = async (headers = f.headers) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal/ws`, {
      headers: { ...Object.fromEntries(headers), Origin: config.baseURL }, handshakeTimeout: 3000 });
    peers.add(socket); socket.on('error', () => {});
    const messages = [];
    socket.on('message', raw => messages.push(readTerminalWsControlFrame(raw)));
    await bounded(new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); }));
    socket.send(createTerminalWsControlFrame({ v: 3, s: 'http-terminal', t: 'attach' }));
    await until(() => messages.some(message => message.t === 'snapshot'));
    const result = messages.find(message => message.t === 'snapshot'); socket.terminate(); return result;
  };
  const otherPerson = async () => {
    const user = await f.helpers.saveUser(f.helpers.createUser({ name: 'Other', email: 'other@example.test', emailVerified: true }));
    await f.adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: 'other-subject',
      createdAt: new Date(), updatedAt: new Date() } });
    const data = record();
    data.orgs[0].members.push({ smarty_id: 'other-person', kind: 'person', status: 'active', role: 'member' });
    data.logins.push({ issuer: 'https://accounts.google.com', subject: 'other-subject', smarty_id: 'other-person' });
    await f.publish(data);
    return { headers: await f.helpers.getAuthHeaders({ userId: user.id }), data };
  };
  return { ...f, spawns, signals, requests, post, create, observe, prepare, withdraw, snapshot, otherPerson,
    spawnBehavior: callback => { spawnBehavior = callback; },
    setStartupOutput: data => { startupOutput = data; },
    close: async () => {
      for (const gate of holds) gate.release();
      for (const socket of peers) socket.terminate();
      try {
        await bounded(Promise.allSettled(requests.map(item => item.finished)), 'route cleanup');
      } finally {
        try { await bounded(runtime.shutdown(), 'runtime shutdown'); }
        finally {
          controller.dispose(); server.closeAllConnections();
          await new Promise(done => server.close(done)); await f.close();
        }
      }
    } };
}
