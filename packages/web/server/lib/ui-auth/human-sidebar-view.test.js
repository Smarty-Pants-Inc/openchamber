import assert from 'node:assert/strict';
import { test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './human-auth.js';
import { createUiAuth } from './ui-auth.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

const config = { baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
  googleClientId: 'fixture-client', googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] };
async function fixture({ preParsed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-view-'));
  const file = join(root, 'auth.sqlite');
  writeFileSync(file, '', { mode: 0o600 });
  const database = new DatabaseSync(file);
  const shared = join(root, 'settings.json');
  writeFileSync(shared, '{"projects":[{"id":"p","sidebarCollapsed":true}]}');
  const human = await createHumanAuth({ ...config, database });
  const fixtureAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await fixtureAuth.$context).test;
  const people = await Promise.all(['a', 'b'].map(name => helpers.saveUser(helpers.createUser({
    name, email: `${name}@example.test`, emailVerified: true }))));
  const headers = await Promise.all([people[0], people[1], people[0]].map(user => helpers.getAuthHeaders({ userId: user.id })));
  const app = express();
  if (preParsed) app.use(express.json({ limit: '1mb' }));
  const tunnel = createTunnelAuth();
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes() {},
    registerNotificationRoutes() {}, registerOpenChamberRoutes() {},
  }).setupBaseRoutes(app, { humanAuth: human, tunnelAuthController: tunnel, process, sessionRuntime: {},
    gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  app.use('/api', (_req, res) => res.status(418).json({ error: 'generic proxy reached' }));
  const call = (device, method = 'get', body) => {
    const result = request(app)[method]('/api/config/sidebar-view').set('Host', 'localhost:43210');
    if (device !== null) result.set(Object.fromEntries(headers[device]));
    if (method === 'patch') result.set('Origin', config.baseURL).send(body);
    return result;
  };
  const owner = i => ({ issuer: config.baseURL, subject: people[i].id });
  return { database, human, headers, people, call, owner, shared,
    close() { uiAuthController.dispose(); tunnel.dispose?.(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('registered protected route isolates people and devices, merges sparse concurrent patches, never edits shared settings', async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.shared, 'utf8');
    const first = await f.call(0).expect(200);
    assert.deepEqual(first.body, { owner: f.owner(0), projects: {}, groups: {} });
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const saved = await f.call(0, 'patch', { owner: f.owner(0), projects: { p: false }, groups: { rendered: true } }).expect(200);
    assert.equal(saved.headers['cache-control'], 'private, no-store');
    assert.deepEqual((await f.call(2).expect(200)).body, saved.body);
    assert.deepEqual((await f.call(1).expect(200)).body, { owner: f.owner(1), projects: {}, groups: {} });
    await f.call(1, 'patch', { owner: f.owner(1), projects: { p: true } }).expect(200);
    await Promise.all([f.call(0, 'patch', { owner: f.owner(0), projects: { q: true } }).expect(200),
      f.call(2, 'patch', { owner: f.owner(0), groups: { other: false } }).expect(200)]);
    assert.deepEqual((await f.call(0).expect(200)).body, { owner: f.owner(0),
      projects: { p: false, q: true }, groups: { rendered: true, other: false } });
    assert.equal(readFileSync(f.shared, 'utf8'), before);
    assert.equal(Object.hasOwn((await f.human.auth.api.getSession({ headers: f.headers[0] })).user, 'sidebarPreferences'), false);
    await assert.rejects(f.human.auth.api.updateUser({ headers: f.headers[0], body: { sidebarPreferences: '{}' } }));
  } finally { f.close(); }
});

test('unsigned, device, spoofed owner, revoked and withdrawn identities cannot read or mutate another person', async () => {
  const f = await fixture();
  try {
    const unsigned = await f.call(null).expect(401);
    assert.equal(unsigned.headers['cache-control'], 'private, no-store');
    await f.call(0).set('Authorization', 'Bearer fixture-device').expect(401);
    await f.call(null).set('X-Smarty-Human-Subject', f.people[0].id).expect(401);
    await f.call(0, 'patch', { owner: f.owner(1), projects: { p: true } }).expect(409);
    await f.call(0, 'patch', { owner: { ...f.owner(0), issuer: 'https://forged.test' }, projects: { p: true } }).expect(409);
    await f.call(0, 'patch', { owner: f.owner(0), projects: { p: true } }).set('Origin', 'https://forged.test').expect(403);
    assert.deepEqual((await f.call(0).expect(200)).body.projects, {});
    await f.human.auth.api.revokeOtherSessions({ headers: f.headers[0] });
    await f.call(2).expect(401);
    f.database.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(f.people[1].id);
    await f.call(1).expect(401);
    await f.human.auth.api.signOut({ headers: f.headers[0] });
    await f.call(0, 'patch', { owner: f.owner(0), projects: { p: true } }).expect(401);
  } finally { f.close(); }
});

test('invalid patches and database failures are atomic, malformed persistence is not empty success', async () => {
  const f = await fixture();
  try {
    const worktree = `p:worktree:/tmp/${'nested-directory/'.repeat(40)}`;
    assert.ok(worktree.length > 512);
    await f.call(0, 'patch', { owner: f.owner(0), projects: { retained: false }, groups: { [worktree]: false } }).expect(200);
    assert.equal((await f.call(0).expect(200)).body.groups[worktree], false);
    for (const body of [{ projects: { x: true } }, { owner: f.owner(0), groups: [] },
      { owner: f.owner(0), projects: { valid: true, bad: 1 } },
      { owner: f.owner(0), groups: { ['x'.repeat(8193)]: false } },
      { owner: f.owner(0), projects: JSON.parse('{"__proto__":true}') },
      { owner: f.owner(0), extra: true }]) await f.call(0, 'patch', body).expect(400);
    await f.call(0, 'patch', { owner: f.owner(0), groups: { ['x'.repeat(70000)]: true } }).expect(413);
    await f.call(0, 'patch', '{broken').set('Content-Type', 'application/json').expect(400);
    const capacity = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [`key${i}`, false]));
    await f.call(1, 'patch', { owner: f.owner(1), groups: capacity }).expect(200);
    await f.call(1, 'patch', { owner: f.owner(1), projects: { untouched: true }, groups: { overflow: true } }).expect(400);
    const retained = (await f.call(1).expect(200)).body;
    assert.equal(Object.keys(retained.groups).length, 2048);
    assert.deepEqual(retained.projects, {});
    f.database.exec("CREATE TRIGGER refuse_sidebar BEFORE UPDATE OF sidebarPreferences ON user BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await f.call(0, 'patch', { owner: f.owner(0), projects: { lost: true } }).expect(500);
    assert.deepEqual((await f.call(0).expect(200)).body.projects, { retained: false });
    f.database.exec('DROP TRIGGER refuse_sidebar');
    await f.call(0, 'patch', { owner: f.owner(0), groups: { recovered: true } }).expect(200);
    f.database.prepare('UPDATE user SET sidebarPreferences = ? WHERE id = ?').run('{broken', f.people[0].id);
    await f.call(0).expect(500);
    await f.call(0, 'patch', { owner: f.owner(0), projects: { lost: true } }).expect(500);
    assert.equal(f.database.prepare('SELECT sidebarPreferences FROM user WHERE id = ?').get(f.people[0].id).sidebarPreferences, '{broken');
  } finally { f.close(); }
});

test('storage byte overflow preserves every key and the same auth owner recovers after controller restart', async () => {
  const f = await fixture();
  let reopened;
  try {
    const batch = n => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p:worktree:/tmp/${n}/${i}/${'directory/'.repeat(200)}`, false]));
    for (let n = 0; n < 6; n++) await f.call(0, 'patch', { owner: f.owner(0), groups: batch(n) }).expect(200);
    await f.call(0, 'patch', { owner: f.owner(0), projects: { lost: true }, groups: batch(6) }).expect(413);
    const saved = (await f.call(0).expect(200)).body;
    assert.equal(Object.keys(saved.groups).length, 120);
    assert.deepEqual(saved.projects, {});
    f.human.dispose();
    reopened = await createHumanAuth({ ...config, database: f.database });
    const req = { headers: Object.fromEntries(f.headers[2]), method: 'GET' };
    req.humanIdentity = reopened.actor(await reopened.resolve(req));
    assert.deepEqual(await reopened.sidebarView(req), saved);
  } finally { reopened?.dispose(); f.close(); }
});

test('already-parsed oversized PATCH still refuses atomically at the registered route', async () => {
  const f = await fixture({ preParsed: true });
  try {
    const groups = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${i}${'x'.repeat(500)}`, false]));
    await f.call(0, 'patch', { owner: f.owner(0), groups }).expect(413);
    assert.deepEqual((await f.call(0).expect(200)).body.groups, {});
  } finally { f.close(); }
});

test('legacy registered route explicitly refuses person preferences', async () => {
  const app = express();
  const tunnel = createTunnelAuth();
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes() {},
    registerNotificationRoutes() {}, registerOpenChamberRoutes() {},
  }).setupBaseRoutes(app, { tunnelAuthController: tunnel, process, sessionRuntime: {},
    gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  try {
    await request(app).get('/api/config/sidebar-view').expect(501);
    const patch = request(app).patch('/api/config/sidebar-view');
    await patch.set('Origin', new URL(patch.url).origin).send({}).expect(501);
  } finally { uiAuthController.dispose(); tunnel.dispose?.(); }
});
