import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createPermissionAutoAcceptRuntime, registerPermissionAutoAcceptRoutes } from './runtime.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createRoutingRuntime } from '../routing/runtime.js';
import { resolveEffectiveConfig } from '../routing/store.js';

const permission = { id: 'pending', sessionID: 'root', permission: 'bash', patterns: ['echo test'], metadata: {} };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const previousFlag = process.env.OPENCHAMBER_ROUTING_ENABLE;
const servers = [];
afterEach(async () => {
  if (previousFlag === undefined) delete process.env.OPENCHAMBER_ROUTING_ENABLE;
  else process.env.OPENCHAMBER_ROUTING_ENABLE = previousFlag;
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});
const listen = async (app) => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};

const createRuntime = ({ enabled = true, evaluatePermission, fetchImpl } = {}) => {
  const stored = { permissionAutoAccept: { sessions: { root: enabled, child: true }, revision: 17 }, unrelated: 'retained' };
  const eventHandlers = [];
  const statusHandlers = [];
  const read = vi.fn(async () => stored);
  const persist = vi.fn(async (changes) => { Object.assign(stored, changes); });
  const fetcher = fetchImpl ?? vi.fn(async (url, init) => {
    if (new URL(url).pathname === '/permission') return Response.json([permission]);
    if (init?.method === 'POST') return Response.json(true);
    return Response.json({ id: 'root' });
  });
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandlers.push(handler); return () => {}; },
      subscribeStatus(handler) { statusHandlers.push(handler); return () => {}; },
    },
    buildOpenCodeUrl: (value) => `http://opencode.test${value}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: read,
    persistSettings: persist,
    evaluatePermission,
    fetchImpl: fetcher,
    retryDelaysMs: [0, 0],
  });
  return { runtime, stored, read, persist, fetcher, eventHandlers, statusHandlers };
};

const routing = (ask) => {
  process.env.OPENCHAMBER_ROUTING_ENABLE = '1';
  const config = resolveEffectiveConfig(null);
  config.enabled = true;
  config.safetyNet = { enabled: true, threshold: 0.6 };
  return createRoutingRuntime({
    dataDir: '/unused',
    buildOpenCodeUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({}),
    store: { readConfig: async () => config, readToken: async () => 'synthetic-test-key' },
    jev: { ask },
  });
};

const indexProbe = `
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
let replies = 0;
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/global/event')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ directory: '/project', payload: { type: 'permission.asked', properties: { id: 'pending', sessionID: 'root', permission: 'bash', patterns: [], metadata: {}, always: [] } } }) + '\\n\\n');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url.startsWith('/permission/')) { replies++; res.end('true'); }
  else if (req.url.includes('health')) res.end('{"healthy":true}');
  else if (req.url.startsWith('/permission')) res.end('[{"id":"pending","sessionID":"root"}]');
  else res.end('[]');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_HOST = 'http://127.0.0.1:' + upstream.address().port;
const originalFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = (input, options) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
    externalAttempts++;
    return Promise.reject(new Error('Fixture denies external network'));
  }
  return originalFetch(input, options);
};
let runtime;
try {
  const { startWebUiServer } = await import(process.env.FIXTURE_INDEX_URL);
  runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, apiOnly: true });
  const origin = 'http://127.0.0.1:' + runtime.getPort();
  for (const route of ['/api/permission-auto-accept', '/api/permission-auto-accept/sessions/root', '/api/notifications/auto-accept']) {
    const method = route.includes('notifications') ? 'POST' : route.includes('sessions') ? 'PUT' : 'GET';
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') options.body = JSON.stringify({ sessionId: 'root', enabled: true, directory: '/project' });
    const response = await fetch(origin + route, options);
    assert.equal(response.status, 501, route);
    assert.equal((await response.json()).supported, false);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(replies, 0, 'startup, stored-enabled policy, reconnect and live SSE must not reply');
  const response = await fetch(origin + '/api/permission/manual/reply?directory=%2Fproject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"reply":"once"}' });
  assert.equal(response.status, 200);
  assert.equal(await response.json(), true);
  assert.equal(replies, 1);
  const settings = JSON.parse(fs.readFileSync(process.env.OPENCHAMBER_DATA_DIR + '/settings.json', 'utf8'));
  assert.deepEqual(settings.permissionAutoAccept, { sessions: { root: true }, revision: 17 });
  assert.equal(externalAttempts, 0);
} finally {
  if (runtime) await runtime.stop({ exitProcess: false });
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
console.log('PERMISSION_INDEX_RECEIPT=stored-retained auto-replies:0 manual-replies:1 feature-and-legacy:501 external:0 stopped');
process.exit(0);
`;

describe('permission auto-accept hard disable', () => {
  for (const outcome of ['accept', 'error', 'timeout']) {
    it(`cannot reply when a pending ${outcome} evaluator is released after Off completes`, async () => {
      const pending = deferred();
      const judge = routing(() => pending.promise);
      const evaluatePermission = vi.fn((request, directory) => judge.evaluatePermission(request, directory));
      const c = createRuntime({ evaluatePermission });
      await c.runtime.load();
      const task = c.runtime.processPermission(permission, '/project');
      await flush();
      // Off is also unsupported after hard disable. Completion of either the
      // old successful Off or the new refusal must leave no reply authority.
      await c.runtime.setSessionPolicy('root', false, '/project').catch(() => undefined);
      if (outcome === 'accept') pending.resolve({ answers: { ask: { noul: 0.1 }, kind: { choice: 'read_only' } } });
      else pending.reject(new Error(outcome === 'timeout' ? 'Jev timed out after 4000ms' : 'Jev unavailable'));
      // If the disabled responder never called the evaluator, consume the
      // deliberately released error here rather than creating an unhandled rejection.
      await pending.promise.catch(() => undefined);
      await task;
      expect(c.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
      expect(evaluatePermission).not.toHaveBeenCalled();
    });
  }

  it('keeps the separate safety decision policy unchanged as a control', async () => {
    const accept = routing(async () => ({ answers: { ask: { noul: 0.1 }, kind: { choice: 'read_only' } } }));
    const hold = routing(async () => ({ answers: { ask: { noul: 0.9 }, kind: { choice: 'git_history' } } }));
    const timeout = routing(async () => { throw new Error('Jev timed out after 4000ms'); });
    expect(await accept.evaluatePermission(permission)).toMatchObject({ action: 'accept' });
    expect(await hold.evaluatePermission(permission)).toMatchObject({ action: 'hold' });
    expect(await timeout.evaluatePermission(permission)).toMatchObject({ action: 'accept', skipped: 'Jev timed out after 4000ms' });
    const off = createRuntime({ enabled: false });
    expect(await off.runtime.processPermission(permission)).toBe(false);
    expect(off.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });

  it('never loads or mutates stored policy, subscribes, evaluates, fetches, or retries', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'accept' }));
    const c = createRuntime({ evaluatePermission });
    const original = JSON.stringify(c.stored);
    const stop = c.runtime.start();
    await c.runtime.load();
    for (const handler of c.eventHandlers) handler({ directory: '/project', payload: { type: 'permission.asked', properties: permission } });
    for (const handler of c.statusHandlers) handler({ type: 'connect' });
    await Promise.all([c.runtime.reconcilePending(), c.runtime.reconcilePending({ directories: ['/project'] })]);
    expect(await c.runtime.processPermission(permission, '/project')).toBe(false);
    expect(await c.runtime.isSessionAutoAccepting('root', '/project')).toBe(false);
    for (const enabled of [true, false]) {
      await expect(c.runtime.setSessionPolicy('root', enabled, '/project')).rejects.toThrow(/unsupported/i);
    }
    stop();
    expect(c.eventHandlers).toEqual([]);
    expect(c.statusHandlers).toEqual([]);
    expect(c.read).not.toHaveBeenCalled();
    expect(c.persist).not.toHaveBeenCalled();
    expect(c.fetcher).not.toHaveBeenCalled();
    expect(evaluatePermission).not.toHaveBeenCalled();
    expect(JSON.stringify(c.stored)).toBe(original);
  });

  it('exported server bootstrap refuses stored-enabled and live-event auto replies, including the legacy toggle', async () => {
    const home = fs.mkdtempSync(path.resolve(import.meta.dirname, '../../../../../.local/permission-index-'));
    fs.chmodSync(home, 0o700);
    fs.mkdirSync(path.join(home, 'data'));
    fs.writeFileSync(path.join(home, 'data/settings.json'), JSON.stringify({ permissionAutoAccept: { sessions: { root: true }, revision: 17 } }));
    try {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', indexProbe], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: home, NODE_ENV: 'test',
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
          OPENCHAMBER_DATA_DIR: path.join(home, 'data'), OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true',
          OPENCHAMBER_ROUTING_ENABLE: '1', FIXTURE_INDEX_URL: new URL('../../index.js', import.meta.url).href },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
      try {
        const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        expect(status, stderr).toBe(0);
        expect(stdout).toContain('PERMISSION_INDEX_RECEIPT=stored-retained auto-replies:0 manual-replies:1 feature-and-legacy:501 external:0 stopped');
      } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL'); }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses HTTP feature routes before the real proxy while manual replies still reach OpenCode', async () => {
    const replies = [];
    const upstream = express();
    upstream.use(express.json());
    upstream.post('/permission/:id/reply', (req, res) => {
      replies.push({ id: req.params.id, body: req.body, directory: req.query.directory });
      res.json(true);
    });
    upstream.use((_req, res) => res.status(599).json({ error: 'unexpected upstream request' }));
    const base = await listen(upstream);
    const c = createRuntime();
    const app = express();
    app.use(express.json());
    registerPermissionAutoAcceptRoutes(app, c.runtime);
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: Number(new URL(base).port), openCodeBaseUrl: base, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (value) => `${base}${value}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    const origin = await listen(app);
    for (const [method, route] of [['GET', '/api/permission-auto-accept'], ['PUT', '/api/permission-auto-accept/sessions/root'], ['POST', '/api/permission-auto-accept/sessions/root'], ['DELETE', '/api/permission-auto-accept/sessions/root']]) {
      const options = { method, headers: { 'Content-Type': 'application/json' } };
      if (method !== 'GET') options.body = JSON.stringify({ enabled: true });
      const response = await fetch(`${origin}${route}`, options);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ supported: false, error: expect.stringMatching(/unsupported/i) });
    }
    expect(replies).toEqual([]);
    for (const reply of ['once', 'always', 'reject']) {
      const response = await fetch(`${origin}/api/permission/manual/reply?directory=%2Fproject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(true);
    }
    expect(replies).toEqual(['once', 'always', 'reject'].map((reply) => ({ id: 'manual', body: { reply }, directory: '/project' })));
    expect(c.persist).not.toHaveBeenCalled();
  });
});
