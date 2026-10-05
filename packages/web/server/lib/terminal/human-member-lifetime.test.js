import assert from 'node:assert/strict';
import { test } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { terminalFixture, until, deferred } from './human-member-fixture.js';
import { record, googleSubject, member } from '../ui-auth/human-member-fixture.js';

for (const mutation of ['removed', 'remapped', 'malformed', 'unreadable']) {
  test(`actual terminal frame refuses ${mutation} authority without terminating native PTY`, async () => {
    const f = await terminalFixture();
    try {
      const peer = await f.open();
      peer.send({ t: 'write', d: 'before' });
      await until(() => f.writes.length === 1);
      if (mutation === 'malformed') await writeFile(f.path, '{broken');
      else if (mutation === 'unreadable') await unlink(f.path);
      else {
        const data = record();
        if (mutation === 'removed') data.orgs[0].members[0].status = 'removed';
        else {
          data.orgs[0].members[0].smarty_id = 'replacement-person';
          data.logins[0].smarty_id = 'replacement-person';
        }
        await f.publish(data);
      }
      peer.send({ t: 'attach' }); peer.send({ t: 'write', d: 'forbidden' });
      await until(() => peer.socket.readyState === 3);
      assert.deepEqual(f.writes, ['before']);
      assert.equal(peer.messages.some(message => message.t === 'snapshot'), false);
      assert.equal(f.killed(), 0);
    } finally { await f.close(); }
  });
}

test('actual terminal pipelined valid writes preserve arrival order across deferred auth', async () => {
  const f = await terminalFixture(), entered = deferred(), release = deferred();
  const original = f.human.auth.api.getSession;
  try {
    const peer = await f.open(); let calls = 0;
    f.human.auth.api.getSession = async (...args) => {
      const result = await original(...args);
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return result;
    };
    peer.send({ t: 'write', d: 'first' }); peer.send({ t: 'write', d: 'second' });
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal frame did not reauthorize')), 500))]);
    assert.deepEqual(f.writes, []);
    release.resolve(); await until(() => f.writes.length === 2);
    assert.deepEqual(f.writes, ['first', 'second']);
    peer.send({ t: 'attach' }); await until(() => peer.messages.some(message => message.t === 'snapshot'));
    f.output('still-running'); await until(() => peer.messages.some(message => message.d === 'still-running'));
  } finally { release.resolve(); f.human.auth.api.getSession = original; await f.close(); }
}, 5000);

test('removal while terminal authorization is deferred prevents queued effects after close', async () => {
  const f = await terminalFixture(), entered = deferred(), release = deferred();
  const original = f.human.auth.api.getSession;
  try {
    const peer = await f.open(); let calls = 0;
    f.human.auth.api.getSession = async (...args) => {
      const result = await original(...args);
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return result;
    };
    peer.send({ t: 'write', d: 'deferred' }); peer.send({ t: 'attach' }); peer.send({ t: 'write', d: 'queued' });
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal frame did not reauthorize')), 500))]);
    const data = record(); data.orgs[0].members[0].status = 'removed'; await f.publish(data);
    release.resolve(); await until(() => peer.socket.readyState === 3);
    assert.deepEqual(f.writes, []);
    assert.equal(peer.messages.some(message => message.t === 'snapshot'), false);
    assert.equal(f.killed(), 0);
  } finally { release.resolve(); f.human.auth.api.getSession = original; await f.close(); }
}, 5000);

test('socket close while terminal authorization is deferred cancels pending native writes', async () => {
  const f = await terminalFixture(), entered = deferred(), release = deferred();
  const original = f.human.auth.api.getSession;
  try {
    const peer = await f.open(); let calls = 0;
    f.human.auth.api.getSession = async (...args) => {
      const result = await original(...args);
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return result;
    };
    peer.send({ t: 'write', d: 'cancelled' }); peer.send({ t: 'write', d: 'queued' });
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal frame did not reauthorize')), 500))]);
    peer.socket.close(); await until(() => peer.socket.readyState === 3);
    release.resolve();
    // A healthy peer's authorized write is a barrier after the released auth read.
    const healthy = await f.open(); healthy.send({ t: 'write', d: 'healthy' });
    await until(() => f.writes.includes('healthy'));
    assert.deepEqual(f.writes, ['healthy']); assert.equal(f.killed(), 0);
  } finally { release.resolve(); f.human.auth.api.getSession = original; await f.close(); }
}, 5000);

test('membership sweep closes idle terminal attachments but preserves another healthy person and PTY', async () => {
  const f = await terminalFixture();
  try {
    const user = await f.helpers.saveUser(f.helpers.createUser({ name: 'Other', email: 'other@example.test', emailVerified: true }));
    await f.adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: 'other-subject',
      createdAt: new Date(), updatedAt: new Date() } });
    const data = record();
    data.orgs[0].members.push({ smarty_id: 'other-person', kind: 'person', status: 'active', role: 'member' });
    data.logins.push({ issuer: 'https://accounts.google.com', subject: 'other-subject', smarty_id: 'other-person' });
    await f.publish(data);
    const withdrawn = await f.open(), healthy = await f.open(await f.helpers.getAuthHeaders({ userId: user.id }));
    withdrawn.send({ t: 'attach' }); healthy.send({ t: 'attach' });
    await until(() => withdrawn.messages.some(message => message.t === 'snapshot') && healthy.messages.some(message => message.t === 'snapshot'));
    data.orgs[0].members[0].status = 'removed'; await f.publish(data);
    await until(() => withdrawn.socket.readyState === 3);
    assert.equal(healthy.socket.readyState, 1); assert.equal(f.killed(), 0);
    healthy.send({ t: 'write', d: 'healthy' }); await until(() => f.writes.length === 1);
    f.output('native-output'); await until(() => healthy.messages.some(message => message.d === 'native-output'));
    assert.deepEqual(f.writes, ['healthy']);
    assert.equal(data.logins[0].subject, googleSubject); assert.equal(data.logins[0].smarty_id, member.smartyId);
  } finally { await f.close(); }
});

test('legacy human mode ignores billing-only Record B withdrawal on terminal frames', async () => {
  const f = await terminalFixture({ extraEnv: { SMARTY_CODE_NODE_ID: undefined } });
  try {
    const peer = await f.open(); await writeFile(f.path, '{broken');
    peer.send({ t: 'write', d: 'legacy' }); peer.send({ t: 'attach' });
    await until(() => f.writes.length === 1 && peer.messages.some(message => message.t === 'snapshot'));
    assert.deepEqual(f.writes, ['legacy']); assert.equal(peer.socket.readyState, 1);
  } finally { await f.close(); }
});
