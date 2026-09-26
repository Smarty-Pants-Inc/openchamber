import { expect, test } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConfiguredHumanAuth } from '../../packages/web/server/lib/ui-auth/human-auth-config.js';
import { createUiAuth } from '../../packages/web/server/lib/ui-auth/ui-auth.js';
import { createBootstrapRuntime } from '../../packages/web/server/lib/opencode/bootstrap-runtime.js';
import {
  registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes,
} from '../../packages/web/server/lib/opencode/core-routes.js';
import { registerFsRoutes } from '../../packages/web/server/lib/fs/routes.js';

// smarty-code#382, in real Chromium, through the production bootstrap: Google human auth (a seeded session cookie,
// SameSite=Lax like better-auth's default), the application-origin check, the /api session gate, and the preview route
// registered where production registers it. The server records every authenticated principal and every mutation.
// The Files view's preview (a capability URL in an iframe with sandbox="allow-scripts") runs its own scripts but reaches
// no authenticated principal and changes nothing. The control iframe (the old preview: the app's own origin with
// allow-same-origin) does both, which proves the recording would see a leak.
const webRequire = createRequire(path.resolve('packages/web/package.json'));
const { betterAuth } = await import(pathToFileURL(webRequire.resolve('better-auth')).href);
const { testUtils } = await import(pathToFileURL(webRequire.resolve('better-auth/plugins')).href);

const probe = `(async () => {
  const r = { inline: window.inline === 1, origin: self.origin };
  try { const res = await fetch('/api/projects/whoami', { credentials: 'include' }); r.status = res.status; r.body = await res.text(); }
  catch (e) { r.fetchError = String(e); }
  try { await fetch('/api/projects/mutate', { method: 'POST', mode: 'no-cors', credentials: 'include',
    headers: { 'Content-Type': 'text/plain' }, body: 'from-preview' }); r.posted = true; } catch (e) { r.postError = String(e); }
  try { r.cookie = document.cookie; } catch (e) { r.cookieError = String(e); }
  try { localStorage.setItem('probe', '1'); r.storage = 'written'; } catch (e) { r.storageError = String(e); }
  try { r.parentTitle = parent.document.title; } catch (e) { r.parentError = String(e); }
  try { top.location.href = '/navigated-by-preview'; } catch (e) { r.topNavigationError = String(e); }
  parent.postMessage(r, '*');
})();`;

let server;
let origin;
let root;
let human;
let cookies;
const principals = [];
const mutations = [];

test.beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-preview-proof-')));
  const site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'),
    '<!doctype html><title>agent page</title><script>window.inline = 1</script><script src="probe.js"></script>');
  await fs.writeFile(path.join(site, 'probe.js'), probe);
  // The PDF preview loads /api/fs/raw in an iframe without a sandbox attribute: a .pdf link to a scripted SVG.
  await fs.writeFile(path.join(site, 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage({ svgRan: true }, "*")</script></svg>');
  await fs.symlink(path.join(site, 'drawing.svg'), path.join(site, 'report.pdf'));

  const app = express();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  human = await createConfiguredHumanAuth({ OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: path.join(root, 'human.sqlite'),
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
    GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' });
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {},
    registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { humanAuth: human, tunnelAuthController: tunnel, process, runtimeName: 'test',
    openchamberVersion: 'fixture', sessionRuntime: {}, gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  // Behind the production gate: reached only by an authenticated request from the application origin.
  app.get('/api/projects/whoami', (req, res) => { principals.push(req.humanIdentity?.subject ?? 'unknown'); res.json({ secret: 'user-data' }); });
  app.post('/api/projects/mutate', express.text(), (req, res) => { mutations.push(String(req.body)); res.json({ ok: true }); });
  registerFsRoutes(app, { os, path, fsPromises: fs, spawn: () => { throw new Error('unused'); }, crypto: { randomUUID: () => 'id-0' },
    normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: site }),
    resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, '.config') });
  // The old, unsafe preview: the same files from the app's own origin, with no CSP (the control).
  app.get('/control/:file', async (req, res) => {
    res.type(path.extname(req.params.file)).send(await fs.readFile(path.join(site, path.basename(req.params.file))));
  });
  app.get('/host', (req, res) => res.send(`<!doctype html><title>Code</title>
    <script>window.results = null; addEventListener('message', (event) => { window.results = event.data; });</script>
    <iframe src="${String(req.query.src)}" ${req.query.sandbox === undefined ? '' : `sandbox="${String(req.query.sandbox)}"`}></iframe>`));

  const seeder = betterAuth({ ...human.auth.options, user: { ...human.auth.options.user, validateUserInfo: undefined },
    plugins: [testUtils()] });
  const helpers = (await seeder.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
  const header = (await helpers.getAuthHeaders({ userId: user.id })).get('cookie');
  cookies = header.split(/;\s*/).map((pair) => {
    const index = pair.indexOf('=');
    return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' };
  });
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  human?.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
  principals.length = 0;
  mutations.length = 0;
  await context.addCookies(cookies);
});

const grant = async (page) => {
  const response = await page.request.post(`${origin}/api/fs/preview`, { headers: { Origin: origin }, data: { path: path.join(root, 'site', 'index.html') } });
  expect(response.status()).toBe(200);
  return (await response.json()).url;
};

const run = async (page, src, sandbox) => {
  await page.goto(`${origin}/host?src=${encodeURIComponent(src)}&sandbox=${encodeURIComponent(sandbox)}`);
  await page.waitForFunction(() => window.results !== null, null, { timeout: 10_000 });
  await page.waitForTimeout(500); // Let the page's own POST and any top navigation reach the server.
  return { results: await page.evaluate(() => window.results), url: page.url() };
};

test('signed in, the preview runs its own scripts but reaches no authenticated principal and changes nothing', async ({ page }) => {
  // The page itself is signed in: the gate admits it.
  const self = await page.request.get(`${origin}/api/projects/whoami`, { headers: { Origin: origin } });
  expect(self.status()).toBe(200);
  expect(principals).toHaveLength(1);
  principals.length = 0;

  const { results, url } = await run(page, await grant(page), 'allow-scripts');
  expect(results.inline).toBe(true);
  expect(results.origin).toBe('null');
  expect(results.body ?? '').not.toContain('user-data');
  expect(principals).toEqual([]);
  expect(mutations).toEqual([]);
  expect(results.cookieError).toBeDefined();
  expect(results.storageError).toBeDefined();
  expect(results.parentError).toBeDefined();
  expect(new URL(url).pathname).toBe('/host');
});

test('control: the old same-origin preview is authenticated as the user and its POST mutates, so a leak would be seen', async ({ page }) => {
  const { results } = await run(page, '/control/index.html', 'allow-scripts allow-same-origin allow-forms');
  expect(results.status).toBe(200);
  expect(results.body).toContain('user-data');
  expect(principals.length).toBeGreaterThan(0);
  expect(mutations).toEqual(['from-preview']);
});

test('the PDF preview of a .pdf link to a scripted SVG loads (200, SVG, sandbox CSP) and runs no script', async ({ page }) => {
  const raw = `/api/fs/raw?path=${encodeURIComponent(path.join(root, 'site', 'report.pdf'))}`;
  const served = page.waitForResponse((response) => response.url().includes('/api/fs/raw'));
  await page.goto(`${origin}/host?src=${encodeURIComponent(raw)}`);
  const response = await served;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/svg+xml');
  expect(response.headers()['content-security-policy']).toBe('sandbox');
  const frame = page.frames().find((candidate) => candidate.url().includes('/api/fs/raw'));
  await frame.waitForLoadState('load');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.results)).toBeNull();
  // Control: the same SVG, served without the sandbox CSP, does run in that iframe.
  await page.goto(`${origin}/host?src=${encodeURIComponent('/control/drawing.svg')}`);
  await page.waitForFunction(() => window.results !== null, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.results)).toEqual({ svgRan: true });
});
