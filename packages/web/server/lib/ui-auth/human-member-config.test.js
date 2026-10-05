import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createConfiguredHumanAuth } from './human-auth-config.js';
import { config, record, member, googleSubject, request, response } from './human-member-fixture.js';
import { createUiAuth } from './ui-auth.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';

function registeredApiGuard(uiAuthController) {
  let guard;
  const app = { get() {}, post() {}, delete() {}, use(path, handler) { if (path === '/api') guard = handler; } };
  registerAuthAndAccessRoutes(app, { express: { json: () => () => {} }, uiAuthController,
    tunnelAuthController: { classifyRequestScope: () => 'local' } });
  assert.ok(guard, 'the production API guard was registered');
  return guard;
}

for (const nodeId of [member.nodeId, '']) for (const mode of [undefined, '', 'off', 'github', 'true', ' google', null]) {
  for (const password of [undefined, 'fixture-password']) test(`Node pin ${JSON.stringify(nodeId)} refuses mode ${String(mode)} before ${password ? 'password' : 'anonymous'} fallback`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-mode-'));
    const path = join(root, 'registry.json'), dbParent = join(root, 'untouched');
    let ui, startupError, controllerCreated = false, apiRegistered = false, downstreamEffects = 0;
    try {
      await writeFile(path, 'preserve billing record');
      const env = { OPENCHAMBER_HUMAN_AUTH: mode, SMARTY_CODE_NODE_ID: nodeId, SMARTY_NODE_RECORD: path,
        OPENCHAMBER_HUMAN_AUTH_DB: join(dbParent, 'human.sqlite'), BETTER_AUTH_URL: config.baseURL,
        BETTER_AUTH_SECRET: config.secret, GOOGLE_CLIENT_ID: config.googleClientId,
        GOOGLE_CLIENT_SECRET: config.googleClientSecret, SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' };
      let human;
      try { human = await createConfiguredHumanAuth(env); } catch (error) { startupError = error; }
      if (!startupError) {
        ui = createUiAuth({ humanAuth: human, password }); controllerCreated = true;
        const guard = registeredApiGuard(ui); apiRegistered = true;
        // This is the actual continuation a downstream native/API receiver would get. Never launch one.
        const res = Object.assign(response(), { type() { return this; }, send() { return this; } });
        await guard({ headers: {}, method: 'GET' }, res, error => { assert.ifError(error); downstreamEffects++; });
      }
      const observed = { controllerCreated, apiRegistered, anonymousAdmitted: downstreamEffects > 0, downstreamEffects };
      assert.ok(startupError, `Node activation downgraded: ${JSON.stringify(observed)}`);
      assert.match(startupError.message, /SMARTY_CODE_NODE_ID requires OPENCHAMBER_HUMAN_AUTH=google/);
      assert.deepEqual(observed, { controllerCreated: false, apiRegistered: false, anonymousAdmitted: false, downstreamEffects: 0 });
      assert.deepEqual(await readdir(root), ['registry.json']);
      await assert.rejects(stat(dbParent), { code: 'ENOENT' });
      assert.equal(await readFile(path, 'utf8'), 'preserve billing record');
    } finally { ui?.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of [undefined, '', 'off']) for (const recordOnly of [false, true]) {
  test(`no Node pin preserves legacy mode ${String(mode)}, billing record ${recordOnly}`, async () => {
    const env = { OPENCHAMBER_HUMAN_AUTH: mode };
    if (recordOnly) env.SMARTY_NODE_RECORD = '/unreadable-billing-only-record';
    const human = await createConfiguredHumanAuth(env);
    assert.equal(human, null);
    const ui = createUiAuth({ humanAuth: human }); let admitted = 0;
    try {
      await registeredApiGuard(ui)({ headers: {}, method: 'GET' }, response(), error => { assert.ifError(error); admitted++; });
      assert.equal(admitted, 1);
    } finally { ui.dispose(); }
  });
}

test('configured factory carries explicit Node pin into admission without changing persistent users or sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-member-'));
  const path = join(root, 'registry.json');
  const env = { OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(root, 'human.sqlite'),
    BETTER_AUTH_URL: config.baseURL, BETTER_AUTH_SECRET: config.secret, GOOGLE_CLIENT_ID: config.googleClientId,
    GOOGLE_CLIENT_SECRET: config.googleClientSecret, SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test',
    SMARTY_NODE_RECORD: path };
  let human;
  try {
    await writeFile(path, JSON.stringify(record()));
    human = await createConfiguredHumanAuth(env);
    const seeder = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await seeder.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    const { adapter } = await human.auth.$context;
    await adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: googleSubject,
      createdAt: new Date(), updatedAt: new Date() } });
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const initial = await human.resolve(request(headers));
    assert.ok(initial);
    assert.equal(Object.hasOwn(human.actor(initial, { forwarded: true }), 'member'), false);
    const group = `human:${initial.session.id}`;
    human.dispose();
    human = await createConfiguredHumanAuth({ ...env, SMARTY_CODE_NODE_ID: 'wrong-node' });
    assert.equal(await human.resolve(request(headers)), null);
    assert.equal(await human.authorizeUiSession(group), false);
    human.dispose();
    human = await createConfiguredHumanAuth({ ...env, SMARTY_CODE_NODE_ID: member.nodeId, SMARTY_NODE_ORG_ID: member.orgId });
    const admitted = await human.resolve(request(headers));
    assert.equal(admitted.user.id, initial.user.id); assert.equal(admitted.session.id, initial.session.id);
    assert.deepEqual(human.actor(admitted, { forwarded: true }).member, member);
    assert.equal(Object.hasOwn(human.actor(admitted), 'member'), false);
    const guard = registeredApiGuard(createUiAuth({ humanAuth: human }));
    let effects = 0;
    const anonymous = response();
    await guard({ headers: {}, method: 'GET' }, anonymous, () => { effects++; });
    assert.equal(anonymous.result().status, 401); assert.equal(effects, 0);
    const req = { ...request(headers), method: 'GET' };
    const res = Object.assign(new EventEmitter(), response());
    res.destroy = () => res.emit('close');
    try {
      await guard(req, res, error => { assert.ifError(error); effects++; });
      assert.equal(effects, 1); assert.deepEqual(req.humanIdentity.member, member);
    } finally { res.emit('finish'); }
    const removed = record(); removed.logins = []; await writeFile(path, JSON.stringify(removed));
    assert.equal(await human.resolve(request(headers)), null);
    human.dispose();
    human = await createConfiguredHumanAuth({ ...env, SMARTY_CODE_NODE_ID: member.nodeId, SMARTY_NODE_RECORD: undefined });
    assert.equal(await human.resolve(request(headers)), null);
    human.dispose();
    human = await createConfiguredHumanAuth(env);
    assert.equal((await human.resolve(request(headers))).session.id, initial.session.id);
  } finally { human?.dispose(); await rm(root, { recursive: true, force: true }); }
});
