// smarty-dev#799: the iPhone share route is the one /api route without a UI session. These tests run the real
// human-mode bootstrap (Better Auth, the origin rule, the /api session gate) and the real generic proxy in front of a
// stand-in gateway, and check what reaches the gateway.
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConfiguredHumanAuth } from '../ui-auth/human-auth-config.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';
import { registerOpenCodeProxy } from './proxy.js';

const config = root => ({ OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(root, 'human.sqlite'),
  BETTER_AUTH_URL: 'http://localhost:43210', BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' });

describe('POST /api/me/share (smarty-dev#799 trust boundary)', () => {
  let root, human, gateway, app, origin, cookie;
  const seen = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'share-route-'));
    human = await createConfiguredHumanAuth(config(root));
    origin = human.auth.options.baseURL;
    gateway = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise(done => gateway.listen(0, '127.0.0.1', done));
    const port = gateway.address().port;
    app = express();
    createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
      registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {},
      registerOpenChamberRoutes: () => {},
    }).setupBaseRoutes(app, { humanAuth: human, process, runtimeName: 'test', openchamberVersion: 'fixture',
      tunnelAuthController: { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() },
      sessionRuntime: {}, gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
    registerOpenCodeProxy(app, { fs, os, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: port, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer server-actor' }),
      buildOpenCodeUrl: pathname => `http://127.0.0.1:${port}${pathname}`, ensureOpenCodeApiPrefix: () => {} });
    const seeder = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await seeder.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    cookie = (await helpers.getAuthHeaders({ userId: user.id })).get('cookie');
  });
  afterAll(async () => {
    await new Promise(done => gateway?.close(done));
    human?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => { seen.length = 0; });

  it('passes without a UI session or Origin and carries the share token, never a client bearer or identity', async () => {
    const response = await request(app).post('/api/me/share')
      .set('x-smarty-share-token', 'share-token-1').set('Authorization', 'Bearer client-guess')
      .set('x-smarty-human-identity', 'forged').set('Content-Type', 'application/json')
      .send('{"text":"Call transcript"}').expect(202);
    expect(response.body).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    const [forwarded] = seen;
    expect(forwarded).toMatchObject({ method: 'POST', url: '/me/share', body: '{"text":"Call transcript"}' });
    expect(forwarded.headers['x-smarty-share-token']).toBe('share-token-1');
    expect(forwarded.headers.authorization).toBe('Bearer server-actor');
    expect(forwarded.headers['x-smarty-human-identity']).toBeUndefined();
  });

  it('still refuses a browser share from another origin', async () => {
    await request(app).post('/api/me/share').set('Origin', 'https://attacker.test')
      .set('x-smarty-share-token', 'share-token-1').send('{}').expect(403);
    expect(seen).toEqual([]);
  });

  it('every other /api route, and any variant of the share path, still needs a session', async () => {
    for (const [method, url] of [
      ['get', '/api/me/share'], ['post', '/api/me/share/'], ['post', '/api/me/share?x=1'], ['post', '/api/me/Share'],
      ['post', '/api/me/%73hare'], ['post', '/api/me/share/extra'], ['post', '/api/me/share-tokens'],
      ['get', '/api/me/share-tokens'], ['post', '/api/me/smarties'], ['get', '/api/session'],
    ]) {
      const response = await request(app)[method](url).set('Origin', origin).set('x-smarty-share-token', 'share-token-1');
      expect([401, 403], `${method} ${url}`).toContain(response.status);
    }
    expect(seen).toEqual([]);
  });

  it('a signed-in request elsewhere reaches the gateway with its identity and without the share token', async () => {
    await request(app).post('/api/me/share-tokens').set('Origin', origin).set('Cookie', cookie)
      .set('x-smarty-share-token', 'share-token-1').expect(202);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/me/share-tokens');
    expect(seen[0].headers['x-smarty-share-token']).toBeUndefined();
    expect(seen[0].headers['x-smarty-human-identity']).toBeTruthy();
  });
});
