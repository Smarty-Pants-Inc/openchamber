import { expect, test } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mintPreviewCapability, registerPreviewServeRoute } from '../../packages/web/server/lib/fs/preview-capability.js';
import { registerFsRoutes } from '../../packages/web/server/lib/fs/routes.js';

// smarty-code#382, in a real browser: the Files view's HTML preview (a capability URL in an iframe with
// sandbox="allow-scripts", served with CSP sandbox) runs the page's own scripts, but cannot use the signed-in user's
// cookies, APIs, storage or window. The control iframe uses the old preview (same origin, allow-same-origin) and must
// read the user's data, which proves this test can see a leak.
const probe = `(async () => {
  const r = { external: true, inline: window.inline === 1, origin: self.origin };
  try { const res = await fetch('/api/secret', { credentials: 'include' }); r.status = res.status; r.body = await res.text(); }
  catch (e) { r.fetchError = String(e); }
  try { r.cookie = document.cookie; } catch (e) { r.cookieError = String(e); }
  try { localStorage.setItem('probe', '1'); r.storage = 'written'; } catch (e) { r.storageError = String(e); }
  try { r.parentTitle = parent.document.title; } catch (e) { r.parentError = String(e); }
  try { top.location.href = '/navigated-by-preview'; } catch (e) { r.topNavigationError = String(e); }
  parent.postMessage(r, '*');
})();`;

let server;
let origin;
let root;
let capability;

test.beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-preview-proof-')));
  await fs.writeFile(path.join(root, 'index.html'),
    '<!doctype html><title>agent page</title><script>window.inline = 1</script><script src="probe.js"></script>');
  await fs.writeFile(path.join(root, 'probe.js'), probe);
  // The PDF preview loads /api/fs/raw in an iframe without a sandbox attribute: a .pdf link to a scripted SVG.
  await fs.writeFile(path.join(root, 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage({ svgRan: true }, "*")</script></svg>');
  await fs.symlink(path.join(root, 'drawing.svg'), path.join(root, 'report.pdf'));
  capability = mintPreviewCapability(root);
  const app = express();
  registerPreviewServeRoute(app);
  registerFsRoutes({ get: (route, handler) => app.get(route, handler), post: () => {} }, {
    os, path, fsPromises: fs, spawn: () => { throw new Error('unused'); }, crypto: { randomUUID: () => 'id-0' },
    normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: root }),
    resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, '.config'),
  });
  app.get('/login', (_req, res) => {
    res.setHeader('Set-Cookie', 'sid=user-1; Path=/; HttpOnly; SameSite=Lax');
    res.send('signed in');
  });
  app.get('/api/secret', (req, res) => ((req.headers.cookie ?? '').includes('sid=user-1')
    ? res.json({ secret: 'user-data' }) : res.status(401).json({ error: 'signed out' })));
  // The old preview: the same files from the app's own origin, with no CSP.
  app.get('/control/:file', async (req, res) => {
    res.type(path.extname(req.params.file)).send(await fs.readFile(path.join(root, path.basename(req.params.file))));
  });
  app.get('/host', (req, res) => res.send(`<!doctype html><title>Code</title>
    <script>window.results = null; addEventListener('message', (event) => { window.results = event.data; });</script>
    <iframe src="${String(req.query.src)}" ${req.query.sandbox === undefined ? '' : `sandbox="${String(req.query.sandbox)}"`}></iframe>`));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

const run = async (page, src, sandbox) => {
  await page.goto(`${origin}/login`);
  await page.goto(`${origin}/host?src=${encodeURIComponent(src)}&sandbox=${encodeURIComponent(sandbox)}`);
  await page.waitForFunction(() => window.results !== null, null, { timeout: 10_000 });
  await page.waitForTimeout(300); // Give a top navigation, if allowed, the time to happen.
  return { results: await page.evaluate(() => window.results), url: page.url() };
};

test('the preview runs its own scripts but cannot act as the signed-in user', async ({ page }) => {
  const { results, url } = await run(page, `/api/fs/preview/${capability}/index.html`, 'allow-scripts');
  expect(results.inline).toBe(true);
  expect(results.external).toBe(true);
  expect(results.origin).toBe('null');
  expect(results.body ?? '').not.toContain('user-data');
  expect(results.fetchError !== undefined || results.status === 401).toBe(true);
  expect(results.cookieError).toBeDefined();
  expect(results.storageError).toBeDefined();
  expect(results.parentError).toBeDefined();
  expect(new URL(url).pathname).toBe('/host');
});

test('control: the old same-origin preview reads the user data, so a leak would be seen', async ({ page }) => {
  const { results } = await run(page, '/control/index.html', 'allow-scripts allow-same-origin allow-forms');
  expect(results.external).toBe(true);
  expect(results.status).toBe(200);
  expect(results.body).toContain('user-data');
});

test('the PDF preview of a .pdf link to a scripted SVG runs no script (raw files are sandboxed documents)', async ({ page }) => {
  await page.goto(`${origin}/login`);
  const raw = `/api/fs/raw?path=${encodeURIComponent(path.join(root, 'report.pdf'))}`;
  await page.goto(`${origin}/host?src=${encodeURIComponent(raw)}`);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.results)).toBeNull();
  // Control: the same SVG, served without the sandbox CSP, does run in that iframe.
  await page.goto(`${origin}/host?src=${encodeURIComponent('/control/drawing.svg')}`);
  await page.waitForFunction(() => window.results !== null, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.results)).toEqual({ svgRan: true });
});
