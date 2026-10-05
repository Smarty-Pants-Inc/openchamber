import assert from 'node:assert/strict';
import { test } from 'vitest';
import { httpFixture, bounded, barrier } from './human-member-http-fixture.js';

for (const stage of ['stat', 'provider', 'shell']) {
  for (const mutation of ['removed', 'suspended', 'remapped', 'malformed', 'missing']) {
    for (const mode of ['interactive', 'command']) {
      test(`deferred authenticated HTTP ${mode} create at ${stage} refuses ${mutation} authority`, async () => {
        const f = await httpFixture(), gate = f.prepare(stage);
        try {
          const request = f.create(mode === 'command' ? { mode, command: 'inert-fixture-command' } : {});
          await bounded(gate.entered);
          assert.equal(f.spawns.length, 0);
          await f.withdraw(mutation);
          gate.release();
          await bounded((await f.observe(0)).finished);
          await request;
          assert.equal(f.spawns.length, 0, 'withdrawn HTTP owner issued a forbidden provider.spawn');
          assert.equal(f.signals.length, 0);
        } finally { gate.release(); await f.close(); }
      });
    }
  }
}

for (const stage of ['stat', 'provider', 'shell']) {
  test(`closed authenticated HTTP response prevents still-unissued create at ${stage}`, async () => {
    const f = await httpFixture(), gate = f.prepare(stage);
    try {
      const request = f.create(); await bounded(gate.entered);
      const observation = await f.observe(0);
      await bounded(new Promise(done => { observation.res.once('close', done); observation.res.destroy(); }));
      gate.release(); await bounded(observation.finished); await request;
      assert.equal(f.spawns.length, 0, 'closed HTTP response still spawned a PTY');
    } finally { gate.release(); await f.close(); }
  });
}

for (const stage of ['stat', 'provider', 'shell']) {
  test(`active HTTP create after deferred ${stage} still launches command mode`, async () => {
    const f = await httpFixture(), gate = f.prepare(stage);
    try {
      const request = f.create({ mode: 'command', command: 'inert-fixture-command' });
      await bounded(gate.entered); gate.release();
      assert.equal((await request).status, 200); assert.equal(f.spawns.length, 1);
      assert.ok(f.spawns[0].args.includes('inert-fixture-command'));
      assert.equal(f.spawns[0].pty.kills.length, 0);
    } finally { gate.release(); await f.close(); }
  });
}

test('already-issued delayed HTTP create settles without membership-driven PTY termination', async () => {
  const f = await httpFixture(), issued = barrier();
  try {
    f.spawnBehavior(async pty => { await issued.hold(); return pty; });
    const request = f.create(); await bounded(issued.entered);
    await f.withdraw('removed'); issued.release();
    await bounded((await f.observe(0)).finished); await request;
    assert.equal(f.spawns.length, 1); assert.equal(f.spawns[0].pty.kills.length, 0);
    assert.deepEqual(f.signals, []);
  } finally { issued.release(); await f.close(); }
});

test('fallback launch rechecks owner after the first issued attempt throws following withdrawal', async () => {
  const f = await httpFixture(), firstAttempt = barrier();
  try {
    f.spawnBehavior(async (pty, count) => {
      if (count === 1) { await firstAttempt.hold(); throw new Error('Inert first launch failure'); }
      return pty;
    });
    const request = f.create({ shell: 'auto' }); await bounded(firstAttempt.entered);
    await f.withdraw('removed'); firstAttempt.release();
    await bounded((await f.observe(0)).finished); await request;
    assert.equal(f.spawns.length, 1, 'fallback borrowed withdrawn authority for another spawn');
    assert.deepEqual(f.signals, []);
  } finally { firstAttempt.release(); await f.close(); }
});

test('active create joiner cannot lend its authority to a removed pending owner', async () => {
  const f = await httpFixture();
  const other = await f.otherPerson(), gate = f.prepare('provider');
  try {
    const owner = f.create(); await bounded(gate.entered);
    const joiner = f.create({}, other.headers); const admittedJoiner = await f.observe(1);
    assert.ok(admittedJoiner.req.humanConnection, 'joiner must pass the real human gate');
    other.data.orgs[0].members[0].status = 'removed'; await f.publish(other.data);
    gate.release(); await bounded(Promise.all([(await f.observe(0)).finished, admittedJoiner.finished]));
    await Promise.all([owner, joiner]);
    assert.equal(f.spawns.length, 0, 'active joiner replaced the original create authority');
    assert.equal((await f.create({ sessionId: 'healthy-terminal' }, other.headers)).status, 200);
    assert.equal(f.spawns.length, 1);
  } finally { gate.release(); await f.close(); }
});

for (const withdrawn of [true, false]) {
  test(`${withdrawn ? 'withdrawn' : 'active'} joining HTTP create preserves its own appearance-write authority`, async () => {
    const f = await httpFixture(), issued = barrier();
    try {
      const other = await f.otherPerson();
      f.setStartupOutput('\u001b[?2031h');
      f.spawnBehavior(async pty => { await issued.hold(); return pty; });
      const owner = f.create({ themeMode: 'dark' }); await bounded(issued.entered);
      const joiner = f.create({ themeMode: 'light' }, other.headers);
      const admittedJoiner = await f.observe(1);
      assert.ok(admittedJoiner.req.humanConnection);
      if (withdrawn) {
        other.data.orgs[0].members[1].status = 'removed'; await f.publish(other.data);
      }
      issued.release();
      await bounded(Promise.all([(await f.observe(0)).finished, admittedJoiner.finished]));
      assert.equal((await owner).status, 200);
      const joinerResult = await joiner;
      if (!withdrawn) assert.equal(joinerResult.status, 200);
      assert.equal(f.spawns.length, 1); assert.deepEqual(f.spawns[0].pty.kills, []);
      assert.deepEqual(f.spawns[0].pty.writes, withdrawn ? [] : ['\u001b[?997;2n'],
        'pending joiner applied appearance without its own current authority');
      f.spawns[0].pty.output('\u001b[?997n');
      assert.equal(f.spawns[0].pty.writes.at(-1), withdrawn ? '\u001b[?997;1n' : '\u001b[?997;2n',
        'query must report the authorized final appearance');
    } finally { issued.release(); await f.close(); }
  });
}

test('non-Node human legacy create ignores billing-only Record B failure', async () => {
  const f = await httpFixture({ extraEnv: { SMARTY_CODE_NODE_ID: undefined } }), gate = f.prepare('provider');
  try {
    const request = f.create(); await bounded(gate.entered);
    await f.withdraw('malformed'); gate.release();
    assert.equal((await request).status, 200); assert.equal(f.spawns.length, 1);
    assert.equal(f.spawns[0].pty.kills.length, 0);
  } finally { gate.release(); await f.close(); }
});
