import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { fixture, record, member, request, response } from './human-member-fixture.js';

const forwarded = (f, session) => f.human.actor(session, { forwarded: true });

test('record presence alone remains billing-only and never enables required Node admission', async () => {
  const f = await fixture({ extraEnv: { SMARTY_CODE_NODE_ID: undefined } });
  try {
    await writeFile(f.path, 'invalid record');
    await f.adapter.deleteMany({ model: 'account', where: [] });
    const session = await f.human.resolve(request(f.headers));
    assert.ok(session); assert.equal(Object.hasOwn(forwarded(f, session), 'member'), false);
    assert.equal(await f.human.authorizeUiSession(`human:${session.session.id}`), true);
  } finally { await f.close(); }
});

test('required Node admission with invalid configuration or unreadable record refuses honestly', async () => {
  for (const extraEnv of [
    { SMARTY_NODE_RECORD: undefined }, { SMARTY_NODE_RECORD: '/nonexistent-node-record-for-fixture' },
    { SMARTY_NODE_RECORD: 'relative/registry.json' }, { SMARTY_CODE_NODE_ID: '' },
    { SMARTY_CODE_NODE_ID: 'node\n' }, { SMARTY_CODE_NODE_ID: 'n'.repeat(64) },
  ]) {
    const f = await fixture({ extraEnv });
    try {
      assert.equal(await f.human.resolve(request(f.headers)), null);
      const res = response(); await f.human.status(request(f.headers), res);
      assert.equal(res.result().status, 401);
      assert.equal(await f.human.authorizeUiSession('human:missing'), false);
    } finally { await f.close(); }
  }
});

test('malformed record and failed Google lookup deny without caching a prior admission', async () => {
  const f = await fixture();
  let spy;
  try {
    const session = await f.human.resolve(request(f.headers));
    const group = `human:${session.session.id}`;
    await writeFile(f.path, '{broken');
    assert.equal(await f.human.resolve(request(f.headers)), null);
    assert.equal(await f.human.authorizeUiSession(group), false);
    await f.publish(record());
    spy = vi.spyOn(f.adapter, 'findMany').mockRejectedValue(new Error('fixture lookup unavailable'));
    assert.equal(await f.human.resolve(request(f.headers)), null);
    assert.equal(await f.human.authorizeUiSession(group), false);
    const res = response(); await f.human.status(request(f.headers), res);
    assert.equal(res.result().status, 401);
    spy.mockRestore(); spy = null;
    assert.deepEqual(forwarded(f, await f.human.resolve(request(f.headers))).member, member);
  } finally { spy?.mockRestore(); await f.close(); }
});

test('membership withdrawal during protect recheck cannot admit an untracked stream', async () => {
  const f = await fixture();
  const original = f.human.auth.api.getSession;
  try {
    let reads = 0;
    f.human.auth.api.getSession = async (...args) => {
      const session = await original(...args);
      if (++reads === 2) {
        const data = record(); data.orgs[0].members[0].status = 'removed'; await f.publish(data);
      }
      return session;
    };
    const stream = new EventEmitter(); let destroyed = false, effects = 0;
    stream.destroy = () => { destroyed = true; stream.emit('close'); };
    await f.human.protect(request(f.headers), stream, () => { effects++; });
    assert.equal(effects, 0); assert.equal(destroyed, true);
  } finally { f.human.auth.api.getSession = original; await f.close(); }
});

test('member-bound connection reauthorization refuses withdrawn members', async () => {
  const f = await fixture();
  try {
    const req = request(f.headers); let effects = 0;
    const stream = new EventEmitter();
    stream.destroy = () => { stream.emit('close'); };
    await f.human.protect(req, stream, () => { effects++; });
    assert.equal(effects, 1);
    assert.equal(await req.humanConnection.authorize(), true);
    const data = record(); data.orgs[0].members[0].status = 'removed'; await f.publish(data);
    assert.equal(await req.humanConnection.authorize(), false);
  } finally { await f.close(); }
});

test('member-bound streams still close on Better Auth revocation, and expired groups stay denied', async () => {
  const f = await fixture();
  try {
    const session = await f.human.resolve(request(f.headers));
    const stream = new EventEmitter(); let destroyed = false;
    stream.destroy = () => { destroyed = true; stream.emit('close'); };
    await f.human.protect(request(f.headers), stream, () => {});
    await f.human.auth.api.signOut({ headers: f.headers });
    assert.equal(destroyed, true);
    assert.equal(await f.human.authorizeUiSession(`human:${session.session.id}`), false);
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const next = await f.human.resolve(request(headers));
    f.database.prepare('UPDATE session SET expiresAt = 0 WHERE id = ?').run(next.session.id);
    assert.equal(await f.human.resolve(request(headers)), null);
    assert.equal(await f.human.authorizeUiSession(`human:${next.session.id}`), false);
  } finally { await f.close(); }
});
