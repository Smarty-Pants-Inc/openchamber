import { expect, test } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createUiAuth } from '../../packages/web/server/lib/ui-auth/ui-auth.js';
import { createBootstrapRuntime } from '../../packages/web/server/lib/opencode/bootstrap-runtime.js';
import {
  registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes,
} from '../../packages/web/server/lib/opencode/core-routes.js';
import { registerFsRoutes } from '../../packages/web/server/lib/fs/routes.js';

// smarty-code#391, in real Chromium, through the production bootstrap in the passwordless LOOPBACK mode (no human auth,
// no UI password): a page in the same browser (here the Files view's sandboxed preview) sends a no-cors, url-encoded
// POST to /api/fs/write and a POST to /api/system/shutdown. Neither may change anything. The control is the same page
// from the application's own origin: its write lands, which proves the check would see a change.
const probe = (target) => `(async () => {
  const body = new URLSearchParams({ path: ${JSON.stringify(target)}, content: 'written by ' + self.origin });
  const r = { origin: self.origin };
  try { await fetch('/api/fs/write', { method: 'POST', mode: 'no-cors', body }); r.write = 'sent'; } catch (e) { r.write = String(e); }
  try { await fetch('/api/system/shutdown', { method: 'POST', mode: 'no-cors' }); r.shutdown = 'sent'; } catch (e) { r.shutdown = String(e); }
  parent.postMessage(r, '*');
})();`;

let server;
let origin;
let root;
let target;
let shutdowns = 0;

test.beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-loopback-origin-')));
  const site = path.join(root, 'site');
  await fs.mkdir(site);
  target = path.join(site, 'notes.txt');
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><title>agent page</title><script src="probe.js"></script>');
  await fs.writeFile(path.join(site, 'probe.js'), probe(target));
  const app = express();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  // Passwordless loopback: no humanAuth, no uiPassword.
  createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {},
    registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { tunnelAuthController: tunnel, process, runtimeName: 'test', openchamberVersion: 'fixture',
    sessionRuntime: {}, gracefulShutdown: async () => { shutdowns++; }, getHealthSnapshot: () => ({}) });
  registerFsRoutes(app, { os, path, fsPromises: fs, spawn: () => { throw new Error('unused'); }, crypto: { randomUUID: () => 'id-0' },
    normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: site }),
    resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, '.config') });
  // The control: the same page from the application's own origin (not sandboxed).
  app.get('/control/:file', async (req, res) => {
    res.type(path.extname(req.params.file)).send(await fs.readFile(path.join(site, path.basename(req.params.file))));
  });
  app.get('/host', (req, res) => res.send(`<!doctype html><title>OpenChamber</title>
    <script>window.results = null; addEventListener('message', (event) => { window.results = event.data; });</script>
    <iframe src="${String(req.query.src)}" ${req.query.sandbox === undefined ? '' : `sandbox="${String(req.query.sandbox)}"`}></iframe>`));
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await fs.writeFile(target, 'original');
  shutdowns = 0;
});

const run = async (page, src, sandbox) => {
  await page.goto(`${origin}/host?src=${encodeURIComponent(src)}${sandbox === undefined ? '' : `&sandbox=${encodeURIComponent(sandbox)}`}`);
  await page.waitForFunction(() => window.results !== null, null, { timeout: 10_000 });
  await page.waitForTimeout(500); // Let both POSTs reach the server.
  return page.evaluate(() => window.results);
};

test('passwordless loopback: a sandboxed page\'s url-encoded write and shutdown change nothing', async ({ page }) => {
  // The page's own grant is a same-origin request: the application may still create a preview.
  const grant = await page.request.post(`${origin}/api/fs/preview`, { headers: { Origin: origin }, data: { path: path.join(root, 'site', 'index.html') } });
  expect(grant.status()).toBe(200);
  const results = await run(page, (await grant.json()).url, 'allow-scripts');
  expect(results.origin).toBe('null');
  expect(results.write).toBe('sent');
  expect(await fs.readFile(target, 'utf8')).toBe('original');
  expect(shutdowns).toBe(0);
});

test('control: the same page from the application origin writes the file, so a change would be seen', async ({ page }) => {
  const results = await run(page, `${origin}/control/index.html`);
  expect(results.origin).toBe(origin);
  expect(await fs.readFile(target, 'utf8')).toBe(`written by ${origin}`);
});
