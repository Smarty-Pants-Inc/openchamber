import { afterEach, expect, it } from 'vitest';
import express from 'express';
import path from 'path';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';

// smarty-code#126 F4: the sidebar shows Herdr's state from the first session list, not only after a live update.
const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))); });

it('session lists keep Herdr state and the no-identity mark, and still drop detail fields', async () => {
  const upstream = express();
  upstream.get('/experimental/session', (_req, res) => res.json([
    { id: 'ses_1', title: 'dev-lead', time: { created: 1, updated: 2 }, herdrState: 'working', permission: [] },
    { id: 'herdr-pane-wA9-p2', title: 'org', time: { created: 0, updated: 0 }, herdrState: 'done', herdrNoIdentity: true },
  ]));
  const upstreamServer = await listen(upstream); servers.push(upstreamServer);
  const base = `http://127.0.0.1:${upstreamServer.address().port}`;
  const app = express();
  registerOpenCodeProxy(app, {
    fs: { promises: { realpath: async (value) => value } }, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: upstreamServer.address().port, openCodeBaseUrl: base, isOpenCodeReady: true,
      openCodeNotReadySince: 0, isRestartingOpenCode: false }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer token' }),
    buildOpenCodeUrl: (requestPath) => `${base}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  const proxy = await listen(app); servers.push(proxy);
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api/experimental/session?limit=500`);
  expect(await response.json()).toEqual([
    { id: 'ses_1', title: 'dev-lead', time: { created: 1, updated: 2 }, herdrState: 'working' },
    { id: 'herdr-pane-wA9-p2', title: 'org', time: { created: 0, updated: 0 }, herdrState: 'done', herdrNoIdentity: true },
  ]);
});
