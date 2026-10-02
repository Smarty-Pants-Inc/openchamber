import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  C1_ADDED_PATHS, C1_PATHS, C1_PREDECESSORS, C1_SOURCE_AUTHORITY,
  C1_PREDECESSOR_BYTES, C1_PREDECESSOR_JSON, c1ThemeOutputSha256, unwindC1Theme,
} from './branding-c1-theme.mjs';
import { responsePolicyOutputSha256 } from './branding-response-policy.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
const json = file => JSON.parse(read(file).toString());
const digest = value => createHash('sha256').update(value).digest('hex');
const overlay = json('branding/behavior-overlay.json');
const coverage = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry]));
const entries = new Map(overlay.files.map(entry => [entry.path, entry]));
const replacements = new Map([
  [C1_PATHS[0], [['text-status-error-text', 'text-destructive']]],
  [C1_PATHS[1], [
    ['var(--primary-text,var(--primary-base))', 'var(--primary-base)'],
    ['var(--status-success-text,var(--status-success))', 'var(--status-success)'],
    ['var(--status-info-text,var(--status-info))', 'var(--status-info)'],
  ]],
  [C1_PATHS[2], [['text-status-error-text', 'text-destructive'], ['text-status-warning-text', 'text-status-warning']]],
  [C1_PATHS[3], ['error', 'success', 'info'].map(role => [`text-status-${role}-text`, `text-[var(--status-${role})]`])],
  [C1_PATHS[4], [['text-status-error-text', 'text-destructive']]],
  [C1_PATHS[5], [['text-status-error-text', 'text-[var(--status-error)]']]],
  [C1_PATHS[6], ['error', 'success', 'warning'].map(role => [`text-status-${role}-text`, `text-[var(--status-${role})]`])],
  [C1_PATHS[7], [['text-status-success-text', 'text-[var(--status-success)]']]],
]);

test('C1 binds the actual released checkpoint and exactly eight current source outputs', () => {
  assert.equal(C1_SOURCE_AUTHORITY, 'ac217edc86ba105269a0af4d16070850f0d1d239');
  assert.equal(overlay.files.length, 49);
  assert.equal(C1_PATHS.length, 8);
  assert.equal(C1_ADDED_PATHS.length, 6);
  for (const [file, predecessor, current] of C1_PREDECESSORS) {
    const entry = entries.get(file);
    assert.equal(entry.brandingSha256, coverage.get(file).outputSha256, file);
    assert.equal(entry.preC1ThemeCombinedSha256, predecessor, file);
    assert.equal(entry.c1ThemeSha256, current, file);
    assert.equal(digest(read(file)), current, file);
    assert.equal(responsePolicyOutputSha256(file, predecessor), current, file);
    let historical = read(file).toString();
    for (const [after, before] of replacements.get(file)) historical = historical.replaceAll(after, before);
    assert.equal(digest(historical), predecessor, `${file}: non-color source changed`);
    if (C1_ADDED_PATHS.includes(file)) {
      assert.equal(entry.behaviorSource, '301db7c8ab0d2455d41ebaa602913bd14ccc9e1a');
      assert.equal(entry.behaviorSha256, entry.brandingSha256);
    }
    const drift = Buffer.from(read(file));
    drift[0] ^= 1;
    assert.throws(() => assert.equal(digest(drift), current), `${file}: one-byte drift must fail`);
  }
});

test('C1 restores the entire exact predecessor before older history is evaluated', () => {
  const historical = unwindC1Theme(overlay);
  assert.equal(historical.files.length, 43);
  assert.equal(digest(JSON.stringify(historical)), C1_PREDECESSOR_JSON);
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), C1_PREDECESSOR_BYTES);
  assert.deepEqual(overlay, json('branding/behavior-overlay.json'), 'unwind must not mutate live evidence');
});

test('C1 rejects widened paths, changed source/current/predecessor bindings and older history', () => {
  const corruptions = [
    value => { value.files.at(-1).path = 'packages/ui/src/components/unreviewed.tsx'; },
    value => { value.files.pop(); },
    value => { value.files.at(-1).c1ThemeAdded = false; },
    value => { value.c1ThemeProvenance.source = '0'.repeat(40); },
    value => { value.files.at(-1).preC1ThemeCombinedSha256 = '0'.repeat(64); },
    value => { value.files.at(-1).c1ThemeSha256 = value.files.at(-1).combinedSha256 = '0'.repeat(64); },
    value => { value.files[0].reason += ' changed'; },
    value => { value.files[0].behaviorSha256 = '0'.repeat(64); },
    value => { value.files.reverse(); },
    value => { value.forgeRunnerProvenance.reviewedHead = '0'.repeat(40); },
  ];
  for (const corrupt of corruptions) {
    const copy = structuredClone(overlay);
    corrupt(copy);
    assert.throws(() => unwindC1Theme(copy));
  }
  assert.throws(() => c1ThemeOutputSha256(overlay, C1_PATHS[0], '0'.repeat(64)));
  assert.equal(c1ThemeOutputSha256(overlay, 'unrelated/path', 'unchanged'), 'unchanged');
});

test('original coverage, parity, generated manifest, response-policy ledger and custom guide stay byte-identical', () => {
  const frozen = [
    ['branding/coverage.json', '10838b01de0e37e7deb6085d7097bfa4699eb71fef0f96ef6d0e1cdf605722df'],
    ['branding/stock-owner-parity.json', 'e432dc759a1b79c9d6e4d6f85d749aa47f1df98cfc8232970b8913e851da4102'],
    ['branding/generated.json', '20fc3389df019ea7c726d381356e6edc7ed5f9637fb6e9dfa6c3d89ad0f97fa1'],
    ['branding/http-response-policy-overlay.json', '0d07d352bad0275e0afd4e98b28bf338478736a962feac35cfaaf137129c454a'],
    ['docs/CUSTOM_THEMES.md', '7086a3e353b1fa9c63cd8e444c015bb16f84e11221d6fbb5bc6a0a202be188ae'],
  ];
  for (const [file, expected] of frozen) assert.equal(digest(read(file)), expected, file);
  for (const entry of json('branding/http-response-policy-overlay.json').files) {
    assert.ok(!C1_PATHS.includes(entry.path), 'response policy and C1 do not overlap');
    assert.equal(responsePolicyOutputSha256(entry.path, entry.predecessorSha256), entry.sha256);
    assert.throws(() => responsePolicyOutputSha256(entry.path, '0'.repeat(64)));
  }
});
