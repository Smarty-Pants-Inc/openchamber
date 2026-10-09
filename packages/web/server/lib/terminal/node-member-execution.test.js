import assert from 'node:assert/strict';
import { test } from 'vitest';
import { executionFixture } from './node-member-execution-fixture.js';

const REFUSAL = "Terminal and commands aren't available for members on this Node yet.";

for (const [name, body] of [['interactive', {}], ['command', { mode: 'command', command: 'inert-fixture-command' }]]) {
  test(`Node member ${name} terminal create gets the refusal and spawns no child`, async () => {
    const f = await executionFixture('member');
    try {
      const created = await f.create(body);
      assert.equal(created.status, 403, JSON.stringify(created.body));
      assert.equal(created.body.error, REFUSAL);
      assert.equal(f.spawns.length, 0);
    } finally { await f.close(); }
  });
}

test('Node member terminal restart gets the refusal and spawns no child', async () => {
  const f = await executionFixture('member');
  try {
    const restarted = await f.post('/api/terminal/execution-terminal/restart', {});
    assert.equal(restarted.status, 403, JSON.stringify(restarted.body));
    assert.equal(restarted.body.error, REFUSAL);
    assert.equal(f.spawns.length, 0);
  } finally { await f.close(); }
});

test('Node member terminal attach and write get the refusal before any socket opens', async () => {
  const f = await executionFixture('member');
  try {
    const result = await f.attachAndWrite('echo member\n');
    assert.deepEqual(result.refused, { status: 403, text: REFUSAL });
    assert.deepEqual(f.writes, []);
    assert.equal(f.spawns.length, 0);
  } finally { await f.close(); }
});

for (const mode of ['human', 'none']) {
  test(`owner path (${mode}, no Node) still creates, attaches, writes, runs commands and restarts`, async () => {
    const f = await executionFixture(mode);
    try {
      const created = await f.create();
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const result = await f.attachAndWrite('echo owner\n');
      assert.equal(result.refused, undefined, JSON.stringify(result.refused));
      assert.deepEqual(f.writes, ['echo owner\n']);
      const restarted = await f.post('/api/terminal/execution-terminal/restart', {});
      assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
      const command = await f.create({ sessionId: 'execution-command', mode: 'command', command: 'inert-fixture-command' });
      assert.equal(command.status, 200, JSON.stringify(command.body));
      assert.equal(f.spawns.length, 3);
    } finally { await f.close(); }
  });
}
