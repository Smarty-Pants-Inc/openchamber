import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, chmod, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { testUtils } from 'better-auth/plugins';
import { createConfiguredHumanAuth } from './human-auth-config.js';
import express from 'express';
import request from 'supertest';
import { createUiAuth } from './ui-auth.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

const config = root => ({ OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(root, 'human.sqlite'),
  BETTER_AUTH_URL: 'http://localhost:43210', BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' });

test('human mode is explicit and missing enabled configuration never falls back', async () => {
  for (const mode of [undefined, '', 'off']) assert.equal(await createConfiguredHumanAuth({ OPENCHAMBER_HUMAN_AUTH: mode }), null);
  for (const mode of ['true', 'github', ' google']) await assert.rejects(createConfiguredHumanAuth({ OPENCHAMBER_HUMAN_AUTH: mode }));
  const root = await mkdtemp(join(tmpdir(), 'human-config-'));
  try {
    const env = config(root);
    for (const field of Object.keys(env).filter(key => key !== 'OPENCHAMBER_HUMAN_AUTH')) {
      const missing = { ...env }; delete missing[field];
      await assert.rejects(createConfiguredHumanAuth(missing), new RegExp(field));
    }
    await assert.rejects(createConfiguredHumanAuth({ ...env, OPENCHAMBER_HUMAN_AUTH_DB: 'relative.sqlite' }));
    await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: '*' }));
    await assert.rejects(stat(env.OPENCHAMBER_HUMAN_AUTH_DB), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private persistent official database preserves a human session across factory restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-config-'));
  let human;
  try {
    const env = config(root);
    human = await createConfiguredHumanAuth(env);
    // Seed only this session-persistence fixture; real OAuth callback gates have separate full tests.
    const seeder = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helper = (await seeder.$context).test;
    const user = await helper.saveUser(helper.createUser({ email: 'person@example.test', emailVerified: true }));
    const headers = await helper.getAuthHeaders({ userId: user.id });
    const first = await human.resolve({ headers: Object.fromEntries(headers) });
    assert.equal((await stat(env.OPENCHAMBER_HUMAN_AUTH_DB)).mode & 0o777, 0o600);
    human.dispose(); human.dispose();
    human = await createConfiguredHumanAuth(env);
    const restored = await human.resolve({ headers: Object.fromEntries(headers) });
    assert.equal(restored.user.id, first.user.id);
    assert.equal(restored.session.id, first.session.id);
  } finally { human?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('prior email-only sessions block activation without deleting users or sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-policy-transition-'));
  const env = config(root);
  let database;
  let human;
  try {
    database = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB);
    await chmod(env.OPENCHAMBER_HUMAN_AUTH_DB, 0o600);
    const options = { database, baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
      plugins: [testUtils()] };
    await (await getMigrations(options)).runMigrations();
    const legacy = betterAuth(options);
    const helpers = (await legacy.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const old = await legacy.api.getSession({ headers });
    database.close(); database = null;
    await assert.rejects(createConfiguredHumanAuth(env), /activation blocked: revoke prior-policy sessions/);
    database = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB);
    assert.equal(database.prepare('SELECT id FROM user WHERE id = ?').get(user.id).id, user.id);
    assert.equal(database.prepare('SELECT workspacePolicy FROM session WHERE id = ?').get(old.session.id).workspacePolicy, null);
    // Only this disposable fixture models the separately owner-approved revocation step.
    const maintenance = betterAuth({ ...options, database });
    await maintenance.api.revokeSessions({ headers });
    database.close(); database = null;
    human = await createConfiguredHumanAuth(env);
    assert.equal(await human.resolve({ headers: Object.fromEntries(headers) }), null);
    assert.equal(await human.authorizeUiSession(`human:${old.session.id}`), false);
    assert.equal((await (await human.auth.$context).internalAdapter.findUserById(user.id)).id, user.id);
  } finally { human?.dispose(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test('offline policy expiry preserves rows and rejects old cookies without owner credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-policy-expiry-'));
  const env = config(root);
  let database;
  let human;
  try {
    database = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB);
    await chmod(env.OPENCHAMBER_HUMAN_AUTH_DB, 0o600);
    const options = { database, baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
      plugins: [testUtils()] };
    await (await getMigrations(options)).runMigrations();
    const legacy = betterAuth(options);
    const helpers = (await legacy.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const old = await legacy.api.getSession({ headers });
    const before = database.prepare('SELECT * FROM session WHERE id = ?').get(old.session.id);
    database.close(); database = null;
    await assert.rejects(createConfiguredHumanAuth(env), /activation blocked/);
    database = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB);
    const { adapter } = await betterAuth({ ...options, database }).$context;
    assert.equal(await adapter.updateMany({ model: 'session', where: [], update: { expiresAt: new Date(0) } }), 1);
    const after = database.prepare('SELECT * FROM session WHERE id = ?').get(old.session.id);
    assert.equal(new Date(after.expiresAt).getTime(), 0);
    assert.ok(new Date(after.updatedAt) >= new Date(before.updatedAt));
    assert.deepEqual({ ...after }, { ...before, expiresAt: after.expiresAt,
      updatedAt: after.updatedAt, workspacePolicy: null });
    assert.equal(database.prepare('SELECT id FROM user WHERE id = ?').get(user.id).id, user.id);
    database.close(); database = null;
    human = await createConfiguredHumanAuth(env);
    assert.equal(await human.authorizeUiSession(`human:${old.session.id}`), false);
    assert.equal(await human.resolve({ headers: Object.fromEntries(headers) }), null);
    assert.equal((await (await human.auth.$context).internalAdapter.findUserById(user.id)).id, user.id);
  } finally { human?.dispose(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test('synchronous bootstrap mounts real auth before JSON and checks application mutation origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-bootstrap-'));
  const human = await createConfiguredHumanAuth(config(root));
  const origin = human.auth.options.baseURL;
  let shutdown = false;
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  const app = express();
  try {
    const bootstrap = createBootstrapRuntime({ express, createUiAuth,
      registerServerStatusRoutes, registerCommonRequestMiddleware, registerAuthAndAccessRoutes,
      registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
    });
    const result = bootstrap.setupBaseRoutes(app, { humanAuth: human, tunnelAuthController: tunnel,
      process, runtimeName: 'test', openchamberVersion: 'fixture', sessionRuntime: {},
      gracefulShutdown: async () => { shutdown = true; }, getHealthSnapshot: () => ({}),
    });
    assert.equal(result.uiAuthController.humanMode, true);
    assert.equal(typeof result.then, 'undefined'); // Keep the existing synchronous caller contract.
    app.post('/api/projects/human-echo', (req, res) => res.json({ body: req.body, actor: req.humanIdentity }));
    const signIn = await request(app).post('/api/auth/sign-in/social').set('Origin', origin)
      .send({ provider: 'google', callbackURL: origin }).expect(200);
    assert.equal(new URL(signIn.body.url).origin, 'https://accounts.google.com');
    await request(app).post('/api/system/shutdown').set('Origin', 'https://attacker.test').expect(403);
    await request(app).post('/api/system/shutdown').expect(403);
    await request(app).post('/api/system/shutdown').set('Origin', origin).expect(401);
    assert.equal(shutdown, false);
    const seeder = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await seeder.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const echo = await request(app).post('/api/projects/human-echo').set('Origin', origin).set('Cookie', headers.get('cookie'))
      .set('x-smarty-human-identity', 'forged').send({ preserved: true }).expect(200);
    assert.deepEqual(echo.body.body, { preserved: true });
    assert.equal(echo.body.actor.subject, user.id);
    await request(app).post('/api/client-auth/pairing/redeem').set('Origin', origin).send({}).expect(409);
    await request(app).post('/api/auth/reset').set('Origin', origin).set('Cookie', headers.get('cookie')).expect(409);
    tunnel.classifyRequestScope = () => 'unknown-public';
    await request(app).post('/api/auth/sign-in/social').set('Origin', origin)
      .send({ provider: 'google', callbackURL: origin }).expect(403);
  } finally { human.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('unsafe database permissions and symlinks are refused without changing existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-config-'));
  try {
    const env = config(root), target = join(root, 'target');
    await writeFile(target, 'preserve', { mode: 0o600 });
    await symlink(target, env.OPENCHAMBER_HUMAN_AUTH_DB);
    await assert.rejects(createConfiguredHumanAuth(env), /private regular/);
    assert.equal(await readFile(target, 'utf8'), 'preserve');
    await rm(env.OPENCHAMBER_HUMAN_AUTH_DB);
    await writeFile(env.OPENCHAMBER_HUMAN_AUTH_DB, '', { mode: 0o644 });
    await assert.rejects(createConfiguredHumanAuth(env), /private regular/);
    await chmod(root, 0o755);
    await assert.rejects(createConfiguredHumanAuth(env), /private database directory/);
    assert.equal(await readFile(env.OPENCHAMBER_HUMAN_AUTH_DB, 'utf8'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
