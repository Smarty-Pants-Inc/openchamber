import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import { fixture, request, record } from './human-member-fixture.js';

function stream() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  return response;
}

for (const remap of ['org', 'subject', 'person']) {
  test(`connection authority stays bound to original ${remap} even when replacement is active`, async () => {
    const f = await fixture();
    try {
      const req = request(f.headers), res = stream();
      await f.human.protect(req, res, () => {});
      const data = record();
      if (remap === 'org') data.orgs[0].id = 'replacement-org';
      if (remap === 'person') {
        data.orgs[0].members[0].smarty_id = 'replacement-person';
        data.logins[0].smarty_id = 'replacement-person';
      }
      if (remap === 'subject') {
        data.logins[0].subject = 'replacement-subject';
        await f.adapter.update({ model: 'account', where: [{ field: 'userId', value: f.user.id }],
          update: { accountId: 'replacement-subject' } });
      }
      await f.publish(data);
      assert.ok(await f.human.resolve(request(f.headers)), 'replacement remains active for a fresh admission');
      assert.equal(await req.humanConnection.authorize(), false);
      assert.equal(res.destroyed, true);
      assert.equal(await req.humanConnection.authorize(), false, 'closed connection cannot be readmitted');
    } finally { await f.close(); }
  });
}

test('membership remap between initial admission and protected recheck is refused', async () => {
  const f = await fixture();
  const original = f.human.auth.api.getSession;
  try {
    let reads = 0, effects = 0;
    f.human.auth.api.getSession = async (...args) => {
      const session = await original(...args);
      if (++reads === 2) {
        const data = record(); data.orgs[0].id = 'replacement-org'; await f.publish(data);
      }
      return session;
    };
    const res = stream(); await f.human.protect(request(f.headers), res, () => { effects++; });
    assert.equal(effects, 0); assert.equal(res.destroyed, true);
  } finally { f.human.auth.api.getSession = original; await f.close(); }
});

test('finished HTTP responses retire their connection authorization and dispose refuses stale handles', async () => {
  const f = await fixture();
  try {
    const req = request(f.headers), res = stream();
    await f.human.protect(req, res, () => {});
    assert.equal(await req.humanConnection.authorize(), true);
    res.emit('finish');
    assert.equal(await req.humanConnection.authorize(), false);
    const next = request(f.headers), live = stream();
    await f.human.protect(next, live, () => {});
    f.human.dispose();
    assert.equal(live.destroyed, true);
    assert.equal(await next.humanConnection.authorize(), false);
  } finally { await f.close(); }
});
