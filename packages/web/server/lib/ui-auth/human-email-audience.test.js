import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createConfiguredHumanAuth } from './human-auth-config.js';
import { response } from './human-member-fixture.js';

// Nine pre-existing Google-admitted people, plus an unlisted person in the same domain.
// All identities, cookies and database rows are disposable fixtures, never production sessions.
const listed = Array.from({ length: 9 }, (_, index) => `person-${index + 1}@example.test`);
const unlisted = 'unlisted@example.test';
const config = root => ({ OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(root, 'human.sqlite'),
  BETTER_AUTH_URL: 'http://localhost:43210', BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' });

async function seed(human, email) {
  const seeder = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await seeder.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email, emailVerified: true, name: 'Fixture person' }));
  const headers = await helpers.getAuthHeaders({ userId: user.id });
  return { user, req: { headers: Object.fromEntries(headers) } };
}

function streamResponse() {
  const res = new EventEmitter();
  res.destroy = () => res.emit('close');
  return res;
}

test('email narrowing preserves nine cookies, identities and stored sidebar preferences across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-email-restart-'));
  const env = config(root);
  let human;
  try {
    human = await createConfiguredHumanAuth(env);
    const saved = [];
    for (const email of [...listed, unlisted]) {
      const data = await seed(human, email);
      const session = await human.resolve(data.req);
      assert.ok(session);
      const actor = human.actor(session, { forwarded: true });
      const { adapter } = await human.auth.$context;
      await adapter.update({ model: 'user', where: [{ field: 'id', value: data.user.id }],
        update: { sidebarPreferences: JSON.stringify({ projects: { '/fixture': true }, groups: { 'fixture-group': false } }) } });
      saved.push({ ...data, actor, sessionId: session.session.id,
        sidebar: await human.sidebarView({ ...data.req, humanIdentity: actor, method: 'GET' }) });
    }
    const before = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB, { readOnly: true });
    const rows = before.prepare('SELECT * FROM session ORDER BY id').all();
    before.close();
    human.dispose();
    human = await createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_ALLOWED_EMAILS: listed.join(',') });
    for (const data of saved) {
      const session = await human.resolve(data.req);
      if (data.user.email === unlisted) {
        assert.ok(await human.auth.api.getSession({ headers: new Headers(data.req.headers) }), 'cookie is valid Better Auth');
        assert.equal(session, null);
        const res = response();
        let effects = 0;
        await human.protect(data.req, res, () => effects++);
        assert.equal(effects, 0);
        assert.deepEqual(res.result(), { status: 401, body: { authenticated: false, locked: true, humanAuthRequired: true } });
        assert.equal(await human.authorizeUiSession(`human:${data.sessionId}`), false);
        continue;
      }
      assert.ok(session, data.user.email);
      assert.equal(session.user.id, data.user.id);
      assert.equal(session.session.id, data.sessionId);
      assert.deepEqual(human.actor(session, { forwarded: true }), data.actor);
      assert.equal(Object.hasOwn(data.actor, 'member'), false, 'email filtering does not enable Node membership');
      assert.deepEqual(await human.sidebarView({ ...data.req, humanIdentity: data.actor, method: 'GET' }), data.sidebar);
      assert.equal(await human.authorizeUiSession(`human:${data.sessionId}`), true);
      const res = streamResponse();
      let effects = 0;
      await human.protect(data.req, res, () => effects++);
      assert.equal(effects, 1);
      assert.deepEqual(data.req.humanIdentity, data.actor);
      res.emit('close');
    }
    const after = new DatabaseSync(env.OPENCHAMBER_HUMAN_AUTH_DB, { readOnly: true });
    assert.deepEqual(after.prepare('SELECT * FROM session ORDER BY id').all(), rows, 'no session migration or revocation');
    after.close();
  } finally { human?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('fresh OAuth validation and account/session creation use the same email audience', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-email-oauth-'));
  let human;
  try {
    human = await createConfiguredHumanAuth({ ...config(root), SMARTY_HUMAN_AUTH_ALLOWED_EMAILS: listed.join(',') });
    const validate = human.auth.options.user.validateUserInfo;
    const source = { method: 'oauth', oauth: { providerId: 'google', profile: { hd: 'example.test' } } };
    assert.equal(await validate({ user: { email: listed[0], emailVerified: true }, source }), undefined);
    assert.equal((await validate({ user: { email: unlisted, emailVerified: true }, source })).error, 'account_not_allowed');
    assert.equal((await validate({ user: { email: listed[0], emailVerified: false }, source })).error, 'account_not_allowed');
    const seeder = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helper = (await seeder.$context).test;
    await assert.rejects(helper.saveUser(helper.createUser({ email: unlisted, emailVerified: true })), /not allowed/);
    // Model an existing user becoming unlisted without passing through the guarded account API.
    const user = await helper.saveUser(helper.createUser({ email: listed[0], emailVerified: true }));
    const { adapter } = await human.auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { email: unlisted } });
    await assert.rejects(helper.getAuthHeaders({ userId: user.id }), /not allowed/);
  } finally { human?.dispose(); await rm(root, { recursive: true, force: true }); }
});
