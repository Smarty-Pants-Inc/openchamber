import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import request from 'supertest';
import { PRODUCT_NAME } from '../../../brand.generated.js';
import { registerGuestRoutes } from './routes.js';
import { clearGuestPendingForTests } from './oauth.js';

const roots = [];
afterEach(async () => {
  clearGuestPendingForTests();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const callbackPath = '/api/guests/branding-test/oauth/callback';
const tokenUrl = 'https://provider.example.test/token';
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-oauth-branding-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<p>Fixture</p>');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'branding-test', version: '1.0.0', openchamber: {
      apiVersion: 1, contributes: {
        panel: { id: 'branding-test', name: 'OpenChamber fixture', icon: 'apps', entry: 'index.html' },
        integration: {
          name: 'OpenChamber provider', description: 'OAuth fixture',
          oauth: {
            authorizeUrl: 'https://provider.example.test/authorize',
            tokenUrl,
            apiOrigin: 'https://provider.example.test',
          },
        },
      },
    },
  }));
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git' });
  const installed = await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  expect(installed.body.guest.name).toBe('OpenChamber fixture');
  return app;
};

const startAuthorization = async (app) => {
  await request(app).put('/api/guests/branding-test/oauth/client').send({ clientId: 'fixture-client' }).expect(200);
  const started = await request(app).post('/api/guests/branding-test/oauth/start').send({}).expect(200);
  const url = new URL(started.body.authorizationUrl);
  expect(new URL(url.searchParams.get('redirect_uri')).pathname).toBe(callbackPath);
  return url.searchParams.get('state');
};

test('registered OAuth callback brands its title and success body without changing route or guest identities', async () => {
  const app = await fixture();
  const state = await startAuthorization(app);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    expect(String(url)).toBe(tokenUrl);
    return new Response(JSON.stringify({ access_token: 'fixture-token' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const response = await request(app).get(callbackPath).query({ state, code: 'fixture-code' }).expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain(`<title>Connected — ${PRODUCT_NAME}</title>`);
    expect(response.text).toContain(`<p>You can close this tab and return to ${PRODUCT_NAME}.</p>`);
    expect(response.text).not.toContain('fixture-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registered OAuth callback escapes external errors without branding their OpenChamber text', async () => {
  const app = await fixture();
  const diagnostic = `OpenChamber provider rejected <script> & "quoted" 'input'`;
  const response = await request(app).get(callbackPath).query({ error: 'access_denied', error_description: diagnostic }).expect(400);
  expect(response.text).toContain(`<title>Could not connect — ${PRODUCT_NAME}</title>`);
  expect(response.text).toContain('<p>OpenChamber provider rejected &lt;script&gt; &amp; &quot;quoted&quot; &#39;input&#39;</p>');
  expect(response.text).not.toContain('<script>');
  expect(response.text).not.toContain(`${PRODUCT_NAME} provider rejected`);
});

test('registered OAuth callback preserves missing-state refusal and unknown-guest response', async () => {
  const app = await fixture();
  const refused = await request(app).get(callbackPath).query({ code: 'fixture-code' }).expect(400);
  expect(refused.text).toContain('<p>Authorization state was missing or expired.</p>');
  const missing = await request(app).get('/api/guests/missing/oauth/callback').expect(404);
  expect(missing.text).toContain(`<title>Unknown extension — ${PRODUCT_NAME}</title>`);
});

test('callback renderer escapes a custom product name, title, and message exactly once', async () => {
  // Exercise the private renderer's actual source without adding a production export
  // or replacing the generated branding file shared with other writers.
  const source = await fs.readFile(new URL('./routes.js', import.meta.url), 'utf8');
  const start = source.indexOf('const escapeHtml =');
  const end = source.indexOf('const sendInstallResult =', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const product = `Custom </title><script> & "Brand" 'name'`;
  const render = vm.runInNewContext(`${source.slice(start, end)}\nrenderOauthCallbackPage`, { PRODUCT_NAME: product });
  const html = render({ title: '<Connected>', message: `You can close this tab and return to ${product}.` });
  const escaped = 'Custom &lt;/title&gt;&lt;script&gt; &amp; &quot;Brand&quot; &#39;name&#39;';
  expect(html).toContain(`<title>&lt;Connected&gt; — ${escaped}</title>`);
  expect(html).toContain(`<p>You can close this tab and return to ${escaped}.</p>`);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('&amp;lt;');
});
