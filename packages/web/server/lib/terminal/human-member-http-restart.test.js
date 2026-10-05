import assert from 'node:assert/strict';
import { test } from 'vitest';
import { httpFixture, bounded, barrier } from './human-member-http-fixture.js';
import { record } from '../ui-auth/human-member-fixture.js';

for (const stage of ['stat', 'shell']) {
  for (const mutation of ['removed', 'suspended', 'remapped', 'malformed', 'missing', 'closed']) {
    test(`deferred authenticated HTTP restart at ${stage} refuses ${mutation} without replacing PTY/history`, async () => {
      const f = await httpFixture();
      let gate;
      try {
        assert.equal((await f.create()).status, 200);
        f.spawns[0].pty.output('retained-native-history');
        const before = await f.snapshot();
        gate = f.prepare(stage);
        const request = f.post('/api/terminal/http-terminal/restart', { shell: 'sh' });
        await bounded(gate.entered);
        const observation = await f.observe(1);
        if (mutation === 'closed') {
          await bounded(new Promise(done => { observation.res.once('close', done); observation.res.destroy(); }));
        } else await f.withdraw(mutation);
        gate.release(); await bounded(observation.finished); await request;
        assert.equal(f.spawns.length, 1, 'refused restart issued a replacement provider.spawn');
        assert.deepEqual(f.spawns[0].pty.kills, []); assert.deepEqual(f.signals, []);
        await f.publish(record());
        const after = await f.snapshot();
        assert.equal(after.history, before.history); assert.equal(after.q, before.q);
        f.spawns[0].pty.output('-still-owned');
        assert.equal((await f.snapshot()).history, 'retained-native-history-still-owned');
      } finally { gate?.release(); await f.close(); }
    });
  }
}

for (const mutation of ['removed', 'suspended', 'remapped', 'malformed', 'missing', 'closed']) {
  test(`queued HTTP restart refuses ${mutation} after an already-issued first restart settles`, async () => {
    const f = await httpFixture(), issued = barrier();
    let queuedPreparation;
    try {
      assert.equal((await f.create()).status, 200);
      f.spawns[0].pty.output('original-history');
      f.spawnBehavior(async (pty, count) => {
        if (count === 2) await issued.hold();
        return pty;
      });
      const first = f.post('/api/terminal/http-terminal/restart', { shell: 'sh' });
      await bounded(issued.entered);
      const second = f.post('/api/terminal/http-terminal/restart', { shell: 'sh' });
      const queued = await f.observe(2);
      assert.ok(queued.req.humanConnection, 'second restart must be admitted through human.protect');
      assert.equal(f.spawns.length, 2, 'second restart must remain queued behind the issued first attempt');
      queuedPreparation = f.prepare('stat');
      if (mutation === 'closed') {
        await bounded(new Promise(done => { queued.res.once('close', done); queued.res.destroy(); }));
      } else await f.withdraw(mutation);
      issued.release();
      await bounded((await f.observe(1)).finished); await first;
      await bounded(queuedPreparation.entered);
      // First issued spawn is now wired. Refusal of second must preserve this outcome and its history.
      f.spawns[1].pty.output('issued-restart-history');
      const killsAfterIssued = f.spawns[0].pty.kills.length;
      assert.equal(killsAfterIssued, 1);
      queuedPreparation.release(); await bounded(queued.finished); await second;
      assert.equal(f.spawns.length, 2, 'withdrawn queued restart issued a third provider.spawn');
      assert.equal(f.spawns[0].pty.kills.length, killsAfterIssued);
      assert.deepEqual(f.spawns[1].pty.kills, []);
      await f.publish(record());
      assert.equal((await f.snapshot()).history, 'issued-restart-history');
      f.spawns[1].pty.output('-retained');
      assert.equal((await f.snapshot()).history, 'issued-restart-history-retained');
    } finally { issued.release(); queuedPreparation?.release(); await f.close(); }
  });
}

test('failed issued restart attempt cannot fall back after withdrawal or alter old PTY/history', async () => {
  const f = await httpFixture(), firstAttempt = barrier();
  try {
    assert.equal((await f.create()).status, 200); f.spawns[0].pty.output('retained-history');
    f.spawnBehavior(async (pty, count) => {
      if (count === 2) { await firstAttempt.hold(); throw new Error('Inert first restart failure'); }
      return pty;
    });
    const request = f.post('/api/terminal/http-terminal/restart', { shell: 'auto' });
    await bounded(firstAttempt.entered); await f.withdraw('removed'); firstAttempt.release();
    await bounded((await f.observe(1)).finished); await request;
    assert.equal(f.spawns.length, 2, 'failed restart retried a spawn with withdrawn authority');
    assert.deepEqual(f.spawns[0].pty.kills, []); assert.deepEqual(f.signals, []);
    await f.publish(record()); assert.equal((await f.snapshot()).history, 'retained-history');
    f.spawns[0].pty.output('-still-running');
    assert.equal((await f.snapshot()).history, 'retained-history-still-running');
  } finally { firstAttempt.release(); await f.close(); }
});

test('active unrelated member can restart while the original member is withdrawn', async () => {
  const f = await httpFixture();
  let gate;
  try {
    const other = await f.otherPerson();
    assert.equal((await f.create()).status, 200); f.spawns[0].pty.output('old-history');
    gate = f.prepare('stat');
    const request = f.post('/api/terminal/http-terminal/restart', { shell: 'sh' }, other.headers);
    await bounded(gate.entered);
    other.data.orgs[0].members[0].status = 'removed'; await f.publish(other.data);
    gate.release(); assert.equal((await request).status, 200);
    assert.equal(f.spawns.length, 2); assert.equal(f.spawns[0].pty.kills.length, 1);
    assert.deepEqual(f.spawns[1].pty.kills, []);
    assert.equal((await f.snapshot(other.headers)).history, '');
    f.spawns[1].pty.output('healthy-history');
    assert.equal((await f.snapshot(other.headers)).history, 'healthy-history');
  } finally { gate?.release(); await f.close(); }
});

test('non-Node human legacy restart retains normal spawn and history reset after failed billing record', async () => {
  const f = await httpFixture({ extraEnv: { SMARTY_CODE_NODE_ID: undefined } });
  let gate;
  try {
    assert.equal((await f.create()).status, 200); f.spawns[0].pty.output('old-history');
    gate = f.prepare('shell');
    const request = f.post('/api/terminal/http-terminal/restart', { shell: 'sh' });
    await bounded(gate.entered); await f.withdraw('malformed'); gate.release();
    assert.equal((await request).status, 200); assert.equal(f.spawns.length, 2);
    assert.equal(f.spawns[0].pty.kills.length, 1); assert.deepEqual(f.spawns[1].pty.kills, []);
    assert.equal((await f.snapshot()).history, '');
  } finally { gate?.release(); await f.close(); }
});
