import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHumanAudience } from './human-audience.js';

test('human mode requires explicit valid audience configuration', () => {
  for (const domains of [undefined, null, [], '', [''], ['*'], ['.example.test'], ['example.test '], [42]]) {
    assert.throws(() => createHumanAudience(domains));
  }
});

test('optional email policy rejects empty, malformed, wildcard and outside-domain lists', () => {
  for (const policy of [null, 42, [], '', ' ', ',', 'person@example.test,', ',person@example.test',
    '*@example.test', 'per*son@example.test', 'person@*.example.test', 'person@other.test',
    'person@@example.test', '@example.test', 'person@', 'two people@example.test', 'person\n@example.test',
    'person@example.test\n', 'person\u0000@example.test', 'Person <person@example.test>',
    '.person@example.test', 'person..other@example.test', 'person.@example.test',
    `${'p'.repeat(65)}@example.test`]) {
    assert.throws(() => createHumanAudience(['example.test'], policy), /Invalid allowed email list/);
  }
});

test('email policy matches only exact lowercase verified addresses within the domain policy', () => {
  const admits = createHumanAudience(['example.test'], ' Person@Example.Test, other@example.test ');
  for (const email of ['person@example.test', 'PERSON@EXAMPLE.TEST', 'other@example.test']) {
    assert.equal(admits({ email, emailVerified: true }), true, email);
  }
  for (const email of ['unlisted@example.test', 'person+alias@example.test', 'person@sub.example.test',
    'person@example.test.attacker.test', ' person@example.test', 'person@example.test\n']) {
    assert.equal(admits({ email, emailVerified: true }), false, email);
  }
  assert.equal(admits({ email: 'person@example.test', emailVerified: false }), false);
  assert.equal(admits({ email: 'person@example.test', emailVerified: 'true' }), false);
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
