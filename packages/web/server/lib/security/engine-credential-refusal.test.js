import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { afterEach, test } from 'vitest';

import { installRetiredRouteRefusal } from './retired-routes.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { createConfiguredHumanAuth } from '../ui-auth/human-auth-config.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

// openchamber#554 review F4: the engine's credential API (SDK auth.set = PUT and
// auth.remove = DELETE /auth/{providerID}, under the /api base) must be refused by
// OpenChamber itself in every auth mode, never forwarded to the engine. Better
// Auth's own sign-in under /api/auth keeps working.
const UPSTREAM_SENTINEL = 'UPSTREAM_SUCCESS_SENTINEL_ENGINE_AUTH';
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

// An engine stand-in that answers every request with a conspicuous success and records it.
const startUpstream = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sentinel: UPSTREAM_SENTINEL }));
  });
  const port = await listen(server);
  cleanups.push(() => close(server));
  return { port, seen, credentialCalls: () => seen.filter((line) => /\/auth\b/i.test(decodeURIComponent(line))) };
};

// The startup pipeline's order: the retired-route refusal, then the generic upstream proxy.
const mountRefusalAndProxy = (app, server, upstreamPort) => {
  installRetiredRouteRefusal({ app, server });
  registerOpenCodeProxy(app, {
    fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream-only' }),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
  });
};

const VARIANTS = [
  ['PUT', '/api/auth/openai'], ['DELETE', '/api/auth/openai'], ['PATCH', '/api/auth/openai'],
  ['PUT', '/API/Auth/openai'], ['PUT', '/api/%61uth/openai'], ['DELETE', '/api//auth/openai'],
  ['PUT', '/api/session/../auth/openai'],
];

test('the SDK auth.set and auth.remove calls get the local 404 and never reach the engine', async () => {
  const upstream = await startUpstream();
  const app = express();
  const server = http.createServer(app);
  mountRefusalAndProxy(app, server, upstream.port);
  const port = await listen(server);
  cleanups.push(() => close(server));

  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}/api` });
  const set = await client.auth.set({ providerID: 'openai', auth: { type: 'api', key: 'sk-fixture' } });
  assert.equal(set.response.status, 404);
  assert.deepEqual(set.error, { error: 'Not Found' });
  const removed = await client.auth.remove({ providerID: 'openai' });
  assert.equal(removed.response.status, 404);

  for (const [method, url] of VARIANTS) {
    const response = await request(server)[method.toLowerCase()](url).send({ type: 'api', key: 'sk-fixture' });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.ok(!JSON.stringify(response.body).includes(UPSTREAM_SENTINEL), `${method} ${url}`);
  }
  assert.deepEqual(upstream.credentialCalls(), []);

  // Control: the generic proxy still forwards other engine calls.
  const providers = await request(server).get('/api/provider');
  assert.equal(providers.body.sentinel, UPSTREAM_SENTINEL);
  assert.deepEqual(upstream.seen, ['GET /provider']);
});

test('human Google mode: Better Auth sign-in still works and a signed-in credential write never reaches the engine', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-auth-refusal-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const human = await createConfiguredHumanAuth({ OPENCHAMBER_HUMAN_AUTH: 'google',
    OPENCHAMBER_HUMAN_AUTH_DB: path.join(root, 'human.sqlite'), BETTER_AUTH_URL: 'http://localhost:43210',
    BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: 'fixture-client',
    GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' });
  cleanups.push(() => human.dispose());
  const origin = human.auth.options.baseURL;
  const upstream = await startUpstream();
  const app = express();
  const server = http.createServer(app);
  createBootstrapRuntime({ express, createUiAuth,
    registerServerStatusRoutes, registerCommonRequestMiddleware, registerAuthAndAccessRoutes,
    registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { humanAuth: human,
    tunnelAuthController: { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() },
    process, runtimeName: 'test', openchamberVersion: 'fixture', sessionRuntime: {},
    gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}),
  });
  mountRefusalAndProxy(app, server, upstream.port);
  const port = await listen(server);
  cleanups.push(() => close(server));

  const signIn = await request(server).post('/api/auth/sign-in/social').set('Origin', origin)
    .send({ provider: 'google', callbackURL: origin });
  assert.equal(signIn.status, 200);
  assert.equal(new URL(signIn.body.url).origin, 'https://accounts.google.com');

  const seeder = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await seeder.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
  const cookie = (await helpers.getAuthHeaders({ userId: user.id })).get('cookie');

  const session = await request(server).get('/api/auth/get-session').set('Cookie', cookie);
  assert.equal(session.status, 200);
  assert.equal(session.body.user.id, user.id);

  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}/api`, headers: { Origin: origin, Cookie: cookie } });
  const set = await client.auth.set({ providerID: 'openai', auth: { type: 'api', key: 'sk-fixture' } });
  assert.equal(set.response.status, 404);
  const removed = await client.auth.remove({ providerID: 'openai' });
  assert.equal(removed.response.status, 404);
  for (const [method, url] of VARIANTS) {
    const response = await request(server)[method.toLowerCase()](url).set('Origin', origin).set('Cookie', cookie)
      .send({ type: 'api', key: 'sk-fixture' });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.ok(!JSON.stringify(response.body).includes(UPSTREAM_SENTINEL), `${method} ${url}`);
  }
  assert.deepEqual(upstream.credentialCalls(), []);

  // Control: the signed-in session still reaches the engine through the proxy.
  const providers = await request(server).get('/api/provider').set('Origin', origin).set('Cookie', cookie);
  assert.equal(providers.body.sentinel, UPSTREAM_SENTINEL);
});
