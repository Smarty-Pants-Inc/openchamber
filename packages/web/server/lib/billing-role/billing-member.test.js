import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBillingRole, registerBillingRoleRoute } from './billing-role.js';
import { fixture, record, request } from '../ui-auth/human-member-fixture.js';

// Real Better Auth account adapter, disposable Record B, and the actual registered route.
test('billing links require one verified Google account and one active person owner even in legacy admission mode', async () => {
  const f = await fixture({ extraEnv: { SMARTY_CODE_NODE_ID: undefined } });
  try {
    let handler;
    registerBillingRoleRoute({ get: (path, route) => { assert.equal(path, '/api/smarty/billing'); handler = route; } }, f.human,
      { billingRole: createBillingRole({ env: { SMARTY_NODE_RECORD: f.path } }) });
    const run = async () => {
      let status = 200, body;
      const res = { set() {}, status(code) { status = code; return this; }, json(value) { body = value; } };
      await handler(request(f.headers), res);
      return { status, body };
    };
    assert.equal((await run()).body.owner, true);
    const data = record(); data.orgs[0].members[0].kind = 'agent'; await f.publish(data);
    assert.deepEqual(await run(), { status: 200, body: { owner: false } });
    await f.publish(record());
    await f.adapter.create({ model: 'account', data: { userId: f.user.id, providerId: 'google', accountId: 'second-google',
      createdAt: new Date(), updatedAt: new Date() } });
    assert.deepEqual(await run(), { status: 200, body: { owner: false } });
    await f.adapter.deleteMany({ model: 'account', where: [{ field: 'userId', value: f.user.id }] });
    assert.deepEqual(await run(), { status: 200, body: { owner: false } });
    await f.human.auth.api.signOut({ headers: f.headers });
    assert.deepEqual(await run(), { status: 401, body: { owner: false } });
  } finally { await f.close(); }
});
