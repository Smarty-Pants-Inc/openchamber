import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHumanAudience } from './human-audience.js';

test('human mode requires explicit valid audience configuration', () => {
  for (const domains of [undefined, null, [], '', [''], ['*'], ['.example.test'], ['example.test '], [42]]) {
    assert.throws(() => createHumanAudience(domains));
  }
});

test('only a server-verified email in the exact normalized domain is admitted', () => {
  const admits = createHumanAudience(['EXAMPLE.TEST']);
  assert.equal(admits({ email: 'person@Example.Test', emailVerified: true }), true);
  for (const email of ['person@other.test', 'person@example.test.attacker.test', 'person@sub.example.test',
    'person@notexample.test', 'person@example.test.', 'person@ｅxample.test', 'person@@example.test',
    '@example.test', ' person@example.test', 'person@example.test\n', 'person\u0000@example.test']) {
    assert.equal(admits({ email, emailVerified: true }), false, email);
  }
  for (const emailVerified of [false, undefined, 'true', 1]) {
    assert.equal(admits({ email: 'person@example.test', emailVerified }), false);
  }
  assert.equal(admits({ name: 'person@example.test', emailVerified: true }), false);
  assert.equal(admits(null), false);
});
