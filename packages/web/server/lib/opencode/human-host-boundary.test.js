import assert from 'node:assert/strict';
import { test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from '../ui-auth/human-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { mintPreviewCapability } from '../fs/preview-capability.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

const baseURL = 'https://code.smartypants.ai';
const aliases = 'code.smartypants.ai,smartypants.smartypants.ai';
const unbound = 'test-org.smartypants.ai';
const refused = (res) => {
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Requests require an application host' });
};

async function fixture(humanMode = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-human-host-')));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html>application page');
  const database = new DatabaseSync(':memory:');
  const human = humanMode ? await createHumanAuth({ database, baseURL,
    secret: 'fixture-only-secret-at-least-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] }) : null;
  let cookie, authCalls = 0, writes = 0;
  if (human) {
    // Official session-only fixture helpers; the production handler and protection remain unchanged.
    const seed = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await seed.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    cookie = (await helpers.getAuthHeaders({ userId: user.id })).get('cookie');
    const handler = human.handler;
    human.handler = (...args) => { authCalls++; return handler(...args); };
  }
  const env = { OPENCHAMBER_ALLOWED_HOSTS: aliases, OPENCHAMBER_DIST_DIR: directory };
  let settings = {}, tunnelUrl = null;
  const readSettingsFromDiskMigrated = async () => settings;
  const app = express();
  app.set('trust proxy', true); // Forwarded Host must not become application authority, even here.
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes: () => {},
    registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { humanAuth: human, process: { env, pid: process.pid }, runtimeName: 'fixture',
    openchamberVersion: 'fixture', sessionRuntime: {}, getHealthSnapshot: () => ({}),
    readSettingsFromDiskMigrated, getTunnelUrl: () => tunnelUrl,
    tunnelAuthController: { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() } });
  app.get('/api/fixture', (req, res) => res.json({ admitted: humanMode ? Boolean(req.humanIdentity) : true }));
  app.post('/api/fs/write', (_req, res) => { writes++; res.json({ ok: true }); });
  createStaticRoutesRuntime({ fs, os, path, express, process: { env }, __dirname: directory,
    readSettingsFromDiskMigrated }).registerStaticRoutes(app);
  const preview = `/api/fs/preview/${mintPreviewCapability(directory)}/index.html`;
  const get = (route, host = 'code.smartypants.ai') => {
    const call = request(app).get(route).set('Host', host);
    return cookie ? call.set('Cookie', cookie) : call;
  };
  return { app, get, preview, env, human, cookie,
    authCalls: () => authCalls, writes: () => writes,
    sources: (nextSettings, nextTunnel) => { settings = nextSettings; tunnelUrl = nextTunnel; },
    close: () => { uiAuthController.dispose(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test.each(['/', '/api/fixture', '/api/system/info', '/health', '/auth/session'])(
  'human %s refuses an unbound Host before serving content or admitting a real session', async (route) => {
  const f = await fixture();
  try {
    await f.get(route, unbound).expect(refused);
    await f.get(route, unbound).set('X-Forwarded-Host', 'code.smartypants.ai')
      .set('Forwarded', 'host=code.smartypants.ai;proto=https').expect(refused);
    await request(f.app).get(route).set('Host', unbound).expect(refused); // Anonymous requests too.
  } finally { f.close(); }
});

test('human unbound callback is refused before the actual OAuth handler', async () => {
  const f = await fixture();
  try {
    await f.get('/api/auth/callback/google', unbound).expect(refused);
    assert.equal(f.authCalls(), 0);
    await f.get('/api/auth/callback/google', unbound).set('X-Forwarded-Host', 'code.smartypants.ai').expect(refused);
    assert.equal(f.authCalls(), 0);
  } finally { f.close(); }
});

test('both served aliases, loopback and IP pass the human Host layer; callback reaches real Better Auth', async () => {
  const f = await fixture();
  try {
    for (const host of [...aliases.split(','), 'localhost:4001', '127.0.0.1:4001', '[::1]:4001', '192.168.1.5:4001']) {
      await f.get('/', host).expect(200, '<!doctype html>application page');
      await f.get('/api/fixture', host).expect(200, { admitted: true });
      await f.get('/health', host).expect(200);
    }
    const callback = await f.get('/api/auth/callback/google').expect(302);
    assert.equal(f.authCalls(), 1);
    assert.ok(callback.headers.location.startsWith(`${baseURL}/api/auth/error?error=`));
    // No code/state supplied: library error redirect proves routing, not Google login or any network exchange.
    await request(f.app).get('/api/fixture').set('Host', 'code.smartypants.ai').expect(401);
  } finally { f.close(); }
});

test('human preview capability cannot bypass Host, but bound opaque-origin preview still serves without a session', async () => {
  const f = await fixture();
  try {
    await request(f.app).get(f.preview).set('Host', unbound).set('Origin', 'null').expect(refused);
    await request(f.app).get(f.preview).set('Host', 'code.smartypants.ai').set('Origin', 'null')
      .expect(200, '<!doctype html>application page').expect('Content-Security-Policy', 'sandbox allow-scripts');
  } finally { f.close(); }
});

test('human configured settings, active tunnel and env hosts are bounded and read at request time', async () => {
  const f = await fixture();
  try {
    f.env.OPENCHAMBER_ALLOWED_HOSTS = ' code.smartypants.ai ,https://env.example.test:444';
    f.sources({ publicOrigin: 'https://settings.example.test:443' }, 'https://tunnel.example.test');
    for (const host of ['settings.example.test', 'tunnel.example.test', 'env.example.test:444']) {
      await f.get('/api/fixture', host).expect(200, { admitted: true });
      await f.get('/api/fixture', `${host.split(':')[0]}.attacker.test`).expect(refused);
    }
    f.sources({}, null); f.env.OPENCHAMBER_ALLOWED_HOSTS = '';
    for (const host of ['settings.example.test', 'tunnel.example.test', 'env.example.test', 'code.smartypants.ai']) {
      await f.get('/api/fixture', host).expect(refused);
    }
    await f.get('/api/fixture', 'localhost').expect(200);
  } finally { f.close(); }
});

test('human ordinary mutations keep the exact configured-origin rule and do not write on refusal', async () => {
  const f = await fixture();
  try {
    const post = (host, origin) => {
      const call = request(f.app).post('/api/fs/write').set('Host', host).set('Cookie', f.cookie).send({});
      return origin === undefined ? call : call.set('Origin', origin);
    };
    for (const origin of [undefined, 'null', 'https://attacker.test', 'https://smartypants.smartypants.ai']) {
      await post('code.smartypants.ai', origin).expect(403,
        { error: 'Human authentication requires the configured application origin' });
    }
    await post(unbound, baseURL).expect(refused);
    assert.equal(f.writes(), 0);
    await post('code.smartypants.ai', baseURL).expect(200);
    assert.equal(f.writes(), 1);
  } finally { f.close(); }
});

test('passwordless preview keeps its capability-only exception for unbound opaque-origin requests', async () => {
  const f = await fixture(false);
  try {
    await f.get(f.preview, unbound).set('Origin', 'null').expect(200, '<!doctype html>application page');
    await f.get('/api/fixture', unbound).expect(refused);
  } finally { f.close(); }
});
