import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { responsePolicyOutputSha256 as currentOutput } from './branding-response-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const overlayPath = 'branding/upstream-v1.24.2-overlay.json';
const overlay = json(overlayPath);
const response = new Map(json('branding/http-response-policy-overlay.json').files.map(entry => [entry.path, entry]));
const stock = new Map(json('branding/stock-owner-parity.json').files.map(entry => [entry.path, entry]));

// Exercise the actual resolver with copies of its actual proof inputs, never module mocks.
const copyProof = () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'smarty-upstream-proof-'));
  for (const file of ['scripts/branding-response-policy.mjs', overlayPath, ...Object.keys(overlay.predecessorLedgers)]) {
    const destination = path.join(fixture, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
  }
  return fixture;
};

test('upstream resolver rejects changed historical proof, source pins and dispositions', async t => {
  const cases = [
    ['base pin', value => { value.baseHead = value.baseHead.slice(0, 8); }, /baseHead|d41518e/],
    ['upstream pin', value => { value.upstreamHead = value.upstreamHead.slice(0, 8); }, /upstreamHead|614d7f/],
    ['ledger pin', value => { value.predecessorLedgers['branding/coverage.json'] = '0'.repeat(64); }, /10838b01/],
    ['raw predecessor', value => { value.files[0].predecessorSha256 = '0'.repeat(64); }, /upstream predecessor changed/],
    ['normalized predecessor', value => { value.files.find(entry => entry.normalizedPredecessorSha256).normalizedPredecessorSha256 = '0'.repeat(64); }, /normalized predecessor changed/],
    ['invented normalized proof', value => { value.files[0].normalizedSha256 = '0'.repeat(64); }, /no normalized stock proof/],
    ['duplicate path', value => { value.files.push(value.files[0]); }, /duplicate upstream merge output/],
    ['unproved path', value => { value.files[0].path = 'unproved.txt'; }, /no historical proof/],
    ['empty disposition', value => { value.files[0].note = ' \n\t'; }, /missing upstream disposition/],
    ['empty outputs', value => { value.files = []; }, /missing upstream merge outputs/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const fixture = copyProof();
      try {
        const value = structuredClone(overlay);
        mutate(value);
        writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
        await assert.rejects(import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href), pattern);
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  }
  await t.test('historical bytes', async () => {
    const fixture = copyProof();
    try {
      writeFileSync(path.join(fixture, 'branding/coverage.json'), `${read('branding/coverage.json')}\n`);
      await assert.rejects(import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href), /historical ledger changed/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

test('upstream resolver keeps raw, normalized and response-policy predecessor contexts separate', async () => {
  const fixture = copyProof();
  try {
    const value = structuredClone(overlay);
    const file = 'packages/vscode/src/bridge-localfs-proxy-runtime.ts';
    const entry = value.files.find(candidate => candidate.path === file);
    const server = value.files.find(candidate => candidate.path === 'packages/web/server/index.js');
    // Fixture digests only. No mutable worktree output is finalized by this test.
    entry.sha256 = 'a'.repeat(64);
    entry.normalizedSha256 = 'b'.repeat(64);
    server.sha256 = 'c'.repeat(64);
    writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
    const { responsePolicyOutputSha256: resolve } = await import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href);
    assert.equal(resolve(file, entry.predecessorSha256), entry.sha256);
    assert.equal(resolve(file, entry.normalizedPredecessorSha256, 'normalized'), entry.normalizedSha256);
    assert.throws(() => resolve(file, entry.normalizedPredecessorSha256), /upstream predecessor changed/);
    assert.throws(() => resolve(file, entry.predecessorSha256, 'normalized'), /normalized predecessor changed/);
    assert.throws(() => resolve(file, entry.predecessorSha256, 'other'), /unsupported output context/);
    const earlier = response.get(server.path);
    assert.equal(resolve(server.path, earlier.predecessorSha256), server.sha256);
    assert.throws(() => resolve(server.path, earlier.sha256), /response-policy predecessor changed/);
    const staticRoutes = response.get('packages/web/server/lib/opencode/static-routes-runtime.js');
    assert.equal(resolve(staticRoutes.path, staticRoutes.predecessorSha256), staticRoutes.sha256);
    assert.equal(resolve('LICENSE', 'd'.repeat(64)), 'd'.repeat(64));
    entry.sha256 = null;
    entry.normalizedSha256 = null;
    writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
    const { responsePolicyOutputSha256: pending } = await import(`${pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href}?pending`);
    assert.throws(() => pending(file, entry.predecessorSha256), /must be finalized after writer release/);
    assert.throws(() => pending(file, entry.normalizedPredecessorSha256, 'normalized'), /must be finalized after writer release/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('every upstream raw successor binds exact finalized current bytes', () => {
  for (const entry of overlay.files) {
    const predecessor = response.get(entry.path)?.predecessorSha256 ?? entry.predecessorSha256;
    assert.equal(currentOutput(entry.path, predecessor), entry.sha256, entry.path);
    assert.equal(digest(read(entry.path)), entry.sha256, entry.path);
  }
});

test('normalized stock successors retain their exact label occurrence and finalized byte checks', () => {
  const normalized = overlay.files.filter(entry => stock.get(entry.path)?.normalize.length);
  assert.equal(normalized.length, 4);
  for (const entry of normalized) {
    const [before, after] = stock.get(entry.path).normalize;
    const source = read(entry.path).toString();
    assert.equal(source.split(before).length - 1, 1, entry.path);
    assert.equal(currentOutput(entry.path, entry.normalizedPredecessorSha256, 'normalized'), entry.normalizedSha256, entry.path);
    assert.equal(digest(source.replace(before, after)), entry.normalizedSha256, entry.path);
    assert.notEqual(entry.normalizedSha256, entry.sha256, entry.path);
  }
});
