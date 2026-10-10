import assert from 'node:assert/strict';
import { test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { makeSignature } from 'better-auth/crypto';
import { createHumanAuth } from './human-auth.js';
import { createUiAuth } from './ui-auth.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

const config = { baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
  googleClientId: 'fixture-client', googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-revocation-'));
  const file = join(root, 'auth.sqlite');
  writeFileSync(file, '', { mode: 0o600 });
  const database = new DatabaseSync(file);
  const human = await createHumanAuth({ ...config, database });
  // Official private fixture helpers, never enabled on the production controller.
  const privateBetterAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await privateBetterAuth.$context).test;
  const people = await Promise.all(['a', 'b'].map(name => helpers.saveUser(helpers.createUser({
    name, email: `${name}@example.test`, emailVerified: true }))));
  const headers = await Promise.all([people[0], people[0]].map(user => helpers.getAuthHeaders({ userId: user.id })));
  const session = await human.resolve({ headers: Object.fromEntries(headers[1]) });
  const app = express();
  const closed = deferred();
  let response;
  app.use((req, res, next) => {
    if (req.method === 'PATCH' && armed) { response = res; res.once('close', closed.resolve); }
    next();
  });
  const tunnel = createTunnelAuth();
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes() {},
    registerNotificationRoutes() {}, registerOpenChamberRoutes() {},
  }).setupBaseRoutes(app, { humanAuth: human, tunnelAuthController: tunnel, process, sessionRuntime: {},
    gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}) });
  app.use('/api', (_req, res) => res.status(418).json({ error: 'generic proxy reached' }));
  const owner = { issuer: config.baseURL, subject: people[0].id };
  const call = (device, method = 'get', body) => {
    const result = request(app)[method]('/api/config/sidebar-view').set('Host', 'localhost:43210')
      .set(Object.fromEntries(headers[device])).timeout({ deadline: 5000 });
    return method === 'patch' ? result.set('Origin', config.baseURL).send(body) : result;
  };
  const { adapter } = await human.auth.$context;
  const originalFind = adapter.findOne;
  const originalView = human.sidebarView;
  const sampled = deferred(), release = deferred(), settled = deferred();
  let armed = false, held = false;
  adapter.findOne = async (...args) => {
    const value = await originalFind(...args);
    // Session resolution uses the library's joined session query. Hold the actual sidebar user read after sampling.
    if (armed && !held && args[0].model === 'user') { held = true; sampled.resolve(); await release.promise; }
    return value;
  };
  human.sidebarView = async (...args) => {
    try { return await originalView(...args); }
    finally { if (armed) settled.resolve(); }
  };
  return { database, human, people, headers, session, owner, call, sampled, release, settled, closed,
    get response() { return response; },
    arm() { armed = true; },
    stored() { return database.prepare('SELECT sidebarPreferences FROM user WHERE id = ?').get(people[0].id).sidebarPreferences; },
    async close() {
      release.resolve();
      adapter.findOne = originalFind; human.sidebarView = originalView;
      uiAuthController.dispose(); tunnel.dispose?.(); database.close(); rmSync(root, { recursive: true, force: true });
    } };
}

for (const ending of ['revoke', 'expire', 'dispose']) test(`held registered PATCH cannot persist after protected response ${ending}`, async () => {
  const f = await fixture();
  try {
    await f.call(0, 'patch', { owner: f.owner, projects: { retained: false } }).expect(200);
    const before = f.stored();
    if (ending === 'expire') {
      // A real non-remembered session expires instead of Better Auth renewing its short deadline on lookup.
      const { authCookies } = await f.human.auth.$context;
      const signed = `true.${await makeSignature('true', config.secret)}`;
      f.headers[1].set('cookie', `${f.headers[1].get('cookie')}; ${authCookies.dontRememberToken.name}=${signed}`);
      f.database.prepare('UPDATE session SET expiresAt = ? WHERE id = ?').run(Date.now() + 1200, f.session.session.id);
    }
    f.arm();
    const pending = f.call(1, 'patch', { owner: f.owner, projects: { forbidden: true } })
      .then(value => ({ value }), error => ({ error }));
    await f.sampled.promise;
    if (ending === 'revoke') await f.human.auth.api.revokeOtherSessions({ headers: f.headers[0] });
    if (ending === 'dispose') f.human.dispose();
    await f.closed.promise;
    assert.equal(f.response.destroyed, true);
    f.release.resolve();
    await f.settled.promise;
    const outcome = await pending;
    assert.ok(outcome.error, 'caller must see the failed connection, not an accepted PATCH');
    assert.equal(outcome.error.code, 'ECONNRESET', 'protected response must close before the client deadline');
    assert.equal(f.stored(), before);
    if (ending === 'dispose') {
      // Disposal closes this controller, not the durable preferences or either library session.
      for (const device of [1, 0]) {
        const refused = await f.call(device).then(value => ({ value }), error => ({ error }));
        assert.ok(refused.error, 'disposed controller must refuse every new admission');
        assert.equal(refused.error.code, 'ECONNRESET');
      }
      assert.equal(f.stored(), before);
      assert.deepEqual(JSON.parse(f.stored()), { projects: { retained: false }, groups: {} });
    } else {
      await f.call(1).expect(401);
      assert.deepEqual((await f.call(0).expect(200)).body.projects, { retained: false });
    }
  } finally { await f.close(); }
});

test('healthy paused registered PATCH commits and private GET sees the durable merge', async () => {
  const f = await fixture();
  try {
    await f.call(0, 'patch', { owner: f.owner, projects: { retained: false } }).expect(200);
    f.arm();
    const pending = f.call(1, 'patch', { owner: f.owner, groups: { allowed: true } }).then(value => value);
    await f.sampled.promise;
    assert.equal(f.response.destroyed, false);
    f.release.resolve();
    const saved = await pending;
    assert.equal(saved.status, 200);
    assert.equal(saved.headers['cache-control'], 'private, no-store');
    const current = await f.call(0).expect(200);
    assert.equal(current.headers['cache-control'], 'private, no-store');
    assert.deepEqual(current.body, { owner: f.owner, projects: { retained: false }, groups: { allowed: true } });
    assert.deepEqual(JSON.parse(f.stored()), { projects: { retained: false }, groups: { allowed: true } });
  } finally { await f.close(); }
});

test('authoritative session owner change during the held user read refuses without writing either person', async () => {
  const f = await fixture();
  try {
    const before = f.stored();
    f.arm();
    const pending = f.call(1, 'patch', { owner: f.owner, projects: { forbidden: true } }).then(value => value);
    await f.sampled.promise;
    f.database.prepare('UPDATE session SET userId = ? WHERE id = ?').run(f.people[1].id, f.session.session.id);
    assert.equal(f.response.destroyed, false);
    f.release.resolve();
    assert.equal((await pending).status, 409);
    assert.equal(f.stored(), before);
    assert.equal(f.database.prepare('SELECT sidebarPreferences FROM user WHERE id = ?').get(f.people[1].id).sidebarPreferences, null);
  } finally { await f.close(); }
});
