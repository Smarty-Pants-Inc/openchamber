import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file).toString());
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('exact stock owners retain all behavior outside the four owned error labels', () => {
  const parity = json('branding/stock-owner-parity.json');
  assert.equal(parity.stock, '2dfd1190eba8853c766c29ae27f09aeacc86bdb9');
  for (const { path: file, normalize, stockSha256 } of parity.files) {
    let source = read(file).toString();
    if (normalize.length) {
      assert.equal(source.split(normalize[0]).length - 1, 1, file);
      source = source.replace(normalize[0], normalize[1]);
    }
    assert.equal(sha256(source), stockSha256, file);
  }
  assert.equal(existsSync(path.join(root, 'packages/vscode/src/bridge-session-runtime.ts')), false);
  assert.equal(existsSync(path.join(root, 'packages/vscode/src/bridge-session-runtime.test.ts')), false);
});

test('every donor file/hunk has a disposition and the reviewed output has not drifted', () => {
  const coverage = json('branding/coverage.json');
  assert.equal(coverage.distinctDonorFiles, 770);
  assert.equal(coverage.files.length, 770);
  assert.deepEqual(coverage.brandedDonorFilesOutsideBothMerges, []);
  assert.equal(new Set(coverage.files.map(({ path }) => path)).size, 770);
  for (const entry of coverage.files) {
    assert.ok(entry.note, entry.path);
    assert.ok(entry.disposition, entry.path);
    assert.ok(entry.sources.length, entry.path);
    for (const source of entry.sources) {
      assert.ok(source.patchSha256, entry.path);
      for (const hunk of source.hunks) assert.ok(hunk.resolution, `${entry.path}: ${hunk.header}`);
    }
    const exists = existsSync(path.join(root, entry.path));
    assert.equal(exists ? sha256(read(entry.path)) : null, entry.outputSha256, entry.path);
  }
});
