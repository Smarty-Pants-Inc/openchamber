import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// smarty-code#1391: an optional members list narrows the domain to named people, re-read on change.
const members = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'human-members-'));
  const file = join(root, 'members.json');
  const write = (value, mode = 0o600) => {
    writeFileSync(file, value instanceof Object ? JSON.stringify(value) : value, { mode });
    chmodSync(file, mode);
  };
  try { await fn({ root, file, write }); } finally { rmSync(root, { recursive: true, force: true }); }
};
const verified = email => ({ email, emailVerified: true });

test('an unset members list keeps the domain rule unchanged', () => {
  const admits = createHumanAudience(['example.test'], {});
  assert.equal(admits(verified('anyone@example.test')), true);
  assert.equal(createHumanAudience(['example.test'], { allowedEmailsFile: undefined })(verified('anyone@example.test')), true);
  for (const allowedEmailsFile of ['', 'members.json', './members.json', 42]) {
    assert.throws(() => createHumanAudience(['example.test'], { allowedEmailsFile }));
  }
});

test('a members list admits only listed people in an allowed domain, case-insensitively', () => members(({ file, write }) => {
  write({ emails: ['Paul@Example.Test', 'kate@example.test', 'outsider@elsewhere.test'] });
  const admits = createHumanAudience(['example.test'], { allowedEmailsFile: file, log: () => {} });
  assert.equal(admits(verified('paul@example.test')), true);
  assert.equal(admits(verified('KATE@EXAMPLE.TEST')), true);
  assert.equal(admits(verified('marisela@example.test')), false, 'same-domain non-member');
  assert.equal(admits(verified('outsider@elsewhere.test')), false, 'listed but outside the domain');
  assert.equal(admits({ email: 'paul@example.test', emailVerified: false }), false);
  assert.equal(admits(verified('paul@example.test.attacker.test')), false);
}));

test('a members list change takes effect on the next check without a restart', () => members(({ file, write }) => {
  write({ emails: ['paul@example.test', 'marisela@example.test'] });
  const admits = createHumanAudience(['example.test'], { allowedEmailsFile: file, log: () => {} });
  assert.equal(admits(verified('marisela@example.test')), true);
  write({ emails: ['paul@example.test'] });
  assert.equal(admits(verified('marisela@example.test')), false);
  assert.equal(admits(verified('paul@example.test')), true);
  write({ emails: ['paul@example.test', 'marisela@example.test'] });
  assert.equal(admits(verified('marisela@example.test')), true);
}));

test('an invalid, unreadable or unsafe members list denies everyone and recovers when fixed', () => members(({ root, file, write }) => {
  const logged = [];
  const admits = createHumanAudience(['example.test'], { allowedEmailsFile: file, log: message => logged.push(message) });
  assert.equal(admits(verified('paul@example.test')), false, 'missing file');
  for (const bad of ['{', '[]', '{"emails":"paul@example.test"}', '{"emails":[42]}', '{"emails":["paul"]}',
    '{"emails":["paul@example.test "]}', '{"emails":["paul@example.test"],"extra":1}', 'null']) {
    write(bad);
    assert.equal(admits(verified('paul@example.test')), false, bad);
  }
  write({ emails: ['paul@example.test'] }, 0o644);
  assert.equal(admits(verified('paul@example.test')), false, 'group/other readable');
  write({ emails: ['paul@example.test'] });
  assert.equal(admits(verified('paul@example.test')), true, 'fixed file admits again');
  const target = join(root, 'target.json');
  writeFileSync(target, JSON.stringify({ emails: ['paul@example.test'] }), { mode: 0o600 });
  rmSync(file); symlinkSync(target, file);
  assert.equal(admits(verified('paul@example.test')), false, 'symlink');
  assert.ok(logged.length > 0 && logged.every(message => !message.includes('paul@')), 'logged without emails');
}));

test('an unchanged invalid members list is not re-parsed on every check', () => members(({ file, write }) => {
  write('{"emails":');
  const admits = createHumanAudience(['example.test'], { allowedEmailsFile: file, log: () => {} });
  const parse = vi.spyOn(JSON, 'parse');
  try {
    for (let i = 0; i < 5; i++) assert.equal(admits(verified('paul@example.test')), false);
    assert.equal(parse.mock.calls.length, 1);
    write({ emails: ['paul@example.test'] });
    assert.equal(admits(verified('paul@example.test')), true);
  } finally { parse.mockRestore(); }
}));
