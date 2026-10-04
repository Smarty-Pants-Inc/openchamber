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
const historical = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry.outputSha256]));
for (const entry of json('branding/behavior-overlay.json').files) historical.set(entry.path, entry.combinedSha256);

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
    ['review predecessor head', value => { value.reviewSuccessors.predecessorHead = value.reviewSuccessors.predecessorHead.slice(0, 8); }, /74503e43/],
    ['review source head', value => { value.reviewSuccessors.reviewedHead = value.reviewSuccessors.reviewedHead.slice(0, 8); }, /4f86403e/],
    ['review raw predecessor', value => { value.reviewSuccessors.files[0].predecessorSha256 = '0'.repeat(64); }, /reviewed predecessor changed/],
    ['review merge predecessor', value => { value.reviewSuccessors.files[1].predecessorSha256 = '0'.repeat(64); }, /reviewed predecessor changed/],
    ['review invented normalized proof', value => { value.reviewSuccessors.files[0].normalizedSha256 = '0'.repeat(64); }, /reviewed successor is raw only/],
    ['review duplicate path', value => { value.reviewSuccessors.files.push(value.reviewSuccessors.files[0]); }, /duplicate reviewed raw output/],
    ['review unproved path', value => { value.reviewSuccessors.files[0].path = 'unproved.txt'; }, /no historical proof/],
    ['review empty disposition', value => { value.reviewSuccessors.files[0].note = ' \n\t'; }, /missing reviewed disposition/],
    ['review empty outputs', value => { value.reviewSuccessors.files = []; }, /missing reviewed raw outputs/],
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
    const serverRound2 = value.round2Successors.files.find(candidate => candidate.path === server.path);
    serverRound2.predecessorSha256 = server.sha256;
    serverRound2.sha256 = server.sha256;
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

test('reviewed raw successors compose with merge outputs without changing normalized contexts', async () => {
  assert.deepEqual(overlay.reviewSuccessors.files.map(entry => entry.path), [
    '.github/workflows/oc-review.yml',
    'packages/web/server/lib/opencode/openchamber-routes.js',
    'packages/web/server/lib/opencode/openchamber-routes.test.js',
  ]);
  for (const entry of overlay.reviewSuccessors.files) {
    const merged = overlay.files.find(candidate => candidate.path === entry.path);
    const predecessor = merged?.predecessorSha256 ?? entry.predecessorSha256;
    if (merged) {
      assert.equal(entry.predecessorSha256, merged.sha256, entry.path);
      assert.throws(() => currentOutput(entry.path, merged.sha256), /upstream predecessor changed/);
    }
    assert.equal(currentOutput(entry.path, predecessor), entry.sha256, entry.path);
    assert.throws(() => currentOutput(entry.path, predecessor, 'normalized'), /no normalized stock proof/);
  }
  const fixture = copyProof();
  try {
    const value = structuredClone(overlay);
    value.reviewSuccessors.files[0].sha256 = null;
    writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
    const { responsePolicyOutputSha256: pending } = await import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href);
    const entry = value.reviewSuccessors.files[0];
    assert.throws(() => pending(entry.path, entry.predecessorSha256), /must be finalized after writer release/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('every upstream raw successor binds exact finalized current bytes', () => {
  const rawOutputs = new Map(overlay.files.map(entry => [entry.path, entry]));
  for (const entry of overlay.reviewSuccessors.files) {
    // Keep the historical resolver input while checking the newest raw output.
    rawOutputs.set(entry.path, { ...entry, predecessorSha256: rawOutputs.get(entry.path)?.predecessorSha256 ?? entry.predecessorSha256 });
  }
  for (const entry of overlay.round2Successors.files) {
    rawOutputs.set(entry.path, { ...entry, predecessorSha256: rawOutputs.get(entry.path)?.predecessorSha256 ?? entry.predecessorSha256 });
  }
  for (const entry of overlay.round4Successors.files) {
    rawOutputs.set(entry.path, { ...entry, predecessorSha256: rawOutputs.get(entry.path)?.predecessorSha256 ?? entry.predecessorSha256 });
  }
  for (const entry of rawOutputs.values()) {
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

test('round2 resolver rejects invalid parent, raw chain, paths, dispositions and hashes', async t => {
  const cases = [
    ['short parent', value => { value.round2Successors.parentHead = value.round2Successors.parentHead.slice(0, 8); }, /16eda5b18ba2cd764d0da0827a2e8741b12d3834/],
    ['wrong parent', value => { value.round2Successors.parentHead = '0'.repeat(40); }, /16eda5b18ba2cd764d0da0827a2e8741b12d3834/],
    ['duplicate path', value => { value.round2Successors.files.push(value.round2Successors.files[0]); }, /duplicate round2 raw output/],
    ['wrong predecessor', value => { value.round2Successors.files[0].predecessorSha256 = '0'.repeat(64); }, /round2 predecessor changed/],
    ['earlier predecessor', value => { const entry = value.round2Successors.files[0]; entry.predecessorSha256 = historical.get(entry.path); }, /round2 predecessor changed/],
    ['malformed predecessor', value => { value.round2Successors.files[0].predecessorSha256 = 'invalid'; }, /invalid round2 predecessor hash/],
    ['uppercase predecessor', value => { value.round2Successors.files[0].predecessorSha256 = 'A'.repeat(64); }, /invalid round2 predecessor hash/],
    ['null predecessor', value => { value.round2Successors.files[0].predecessorSha256 = null; }, /round2 predecessor hash|must be of type string/],
    ['normalized predecessor field', value => { value.round2Successors.files[0].normalizedPredecessorSha256 = 'a'.repeat(64); }, /round2 successor is raw only/],
    ['normalized output field', value => { value.round2Successors.files[0].normalizedSha256 = 'b'.repeat(64); }, /round2 successor is raw only/],
    ['normalized predecessor value', value => { value.round2Successors.files[0].predecessorSha256 = value.files.find(entry => entry.normalizedPredecessorSha256).normalizedPredecessorSha256; }, /round2 predecessor changed/],
    ['normalized path', value => { const normalized = value.files.find(entry => entry.normalizedPredecessorSha256); value.round2Successors.files[0].path = normalized.path; value.round2Successors.files[0].predecessorSha256 = normalized.sha256; }, /round2 cannot extend a normalized stock path/],
    ['unproved path', value => { value.round2Successors.files[0].path = 'unproved-round2.txt'; }, /no historical proof/],
    ['blank path', value => { value.round2Successors.files[0].path = ' \n\t'; }, /no historical proof/],
    ['empty outputs', value => { value.round2Successors.files = []; }, /missing round2 raw outputs/],
    ['blank note', value => { value.round2Successors.files[0].note = ' \n\t'; }, /missing round2 disposition/],
    ['missing note', value => { delete value.round2Successors.files[0].note; }, /missing round2 disposition|must be of type string/],
    ['malformed output', value => { value.round2Successors.files[0].sha256 = 'invalid'; }, /must be finalized after writer release/],
    ['uppercase output', value => { value.round2Successors.files[0].sha256 = 'A'.repeat(64); }, /must be finalized after writer release/],
    ['blank output', value => { value.round2Successors.files[0].sha256 = ' \n\t'; }, /must be finalized after writer release/],
    ['missing output', value => { delete value.round2Successors.files[0].sha256; }, /must be finalized after writer release|must be of type string/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const fixture = copyProof();
      try {
        const value = structuredClone(overlay);
        for (const entry of value.round2Successors.files) entry.sha256 = 'e'.repeat(64);
        mutate(value);
        writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
        await assert.rejects(import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href), pattern);
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  }
  await t.test('null prepared outputs forbid current-byte claims', async () => {
    const fixture = copyProof();
    try {
      const value = structuredClone(overlay);
      for (const entry of value.round2Successors.files) entry.sha256 = null;
      writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
      const { responsePolicyOutputSha256: resolve } = await import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href);
      for (const entry of value.round2Successors.files) {
        assert.throws(() => resolve(entry.path, historical.get(entry.path)), /round2 output hash must be finalized after writer release/);
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

test('round2 raw fixtures compose every earlier layer from the original historical input', async () => {
  const fixture = copyProof();
  try {
    const value = structuredClone(overlay);
    for (const entry of value.round2Successors.files) entry.sha256 = 'e'.repeat(64);
    // Exercise review-only, upstream-plus-review and response-only parents as well as actual candidates.
    for (const prior of [...value.reviewSuccessors.files, response.get('packages/web/server/lib/opencode/static-routes-runtime.js')]) {
      value.round2Successors.files.push({ path: prior.path, predecessorSha256: prior.sha256, sha256: 'f'.repeat(64), note: 'Raw composition fixture only.' });
    }
    writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
    const { responsePolicyOutputSha256: resolve } = await import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href);
    for (const entry of value.round2Successors.files) {
      const reviewed = value.reviewSuccessors.files.find(candidate => candidate.path === entry.path);
      const merged = value.files.find(candidate => candidate.path === entry.path);
      const immediate = reviewed?.sha256 ?? merged?.sha256 ?? response.get(entry.path)?.sha256 ?? historical.get(entry.path);
      assert.equal(entry.predecessorSha256, immediate, entry.path);
      assert.equal(resolve(entry.path, historical.get(entry.path)), entry.sha256, entry.path);
      // A coverage-only path has no earlier hop: its immediate predecessor is the original caller.
      if (entry.predecessorSha256 !== historical.get(entry.path)) {
        assert.throws(() => resolve(entry.path, entry.predecessorSha256), /predecessor changed/, entry.path);
      }
      assert.throws(() => resolve(entry.path, '0'.repeat(64)), /predecessor changed/, entry.path);
      assert.throws(() => resolve(entry.path, historical.get(entry.path), 'normalized'), /no normalized stock proof/, entry.path);
    }
    const untouched = value.files.find(entry => entry.path === 'Dockerfile');
    assert.equal(resolve(untouched.path, historical.get(untouched.path)), untouched.sha256);
    for (const entry of value.files.filter(candidate => candidate.normalizedPredecessorSha256)) {
      assert.equal(resolve(entry.path, entry.normalizedPredecessorSha256, 'normalized'), entry.normalizedSha256, entry.path);
      assert.throws(() => resolve(entry.path, historical.get(entry.path), 'normalized'), /normalized predecessor changed/, entry.path);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('F13 namespace successors bind the complete all-method guards from original historical callers', async t => {
  assert.equal(overlay.round2Successors.files.length, 9);
  for (const file of ['packages/vscode/webview/main.tsx', 'packages/vscode/src/bridge-proxy-runtime.ts']) {
    const entry = overlay.round2Successors.files.find(candidate => candidate.path === file);
    const merged = overlay.files.find(candidate => candidate.path === file);
    const caller = historical.get(file);
    assert.equal(entry.predecessorSha256, merged?.sha256 ?? caller, file);
    assert.equal(currentOutput(file, caller), digest(read(file)), file);
    assert.equal(entry.sha256, digest(read(file)), file);
    assert.throws(() => currentOutput(file, entry.sha256), /predecessor changed/, file);
    assert.throws(() => currentOutput(file, caller, 'normalized'), /no normalized stock proof/, file);
    for (const [name, mutate, pattern] of [
      ['wrong predecessor', row => { row.predecessorSha256 = '0'.repeat(64); }, /round2 predecessor changed/],
      ['normalized output', row => { row.normalizedSha256 = 'a'.repeat(64); }, /round2 successor is raw only/],
      ['blank disposition', row => { row.note = ' '; }, /missing round2 disposition/],
    ]) {
      await t.test(`${file}: ${name}`, async () => {
        const fixture = copyProof();
        try {
          const value = structuredClone(overlay);
          mutate(value.round2Successors.files.find(candidate => candidate.path === file));
          writeFileSync(path.join(fixture, overlayPath), JSON.stringify(value));
          await assert.rejects(import(pathToFileURL(path.join(fixture, 'scripts/branding-response-policy.mjs')).href), pattern);
        } finally { rmSync(fixture, { recursive: true, force: true }); }
      });
    }
  }
});

test('A9 round4 successor binds frozen current bytes from the original caller and rejects alternate authority', async t => {
  const file = 'packages/ui/src/lib/worktreeSessionCreator.ts';
  const entry = overlay.round4Successors.files[0];
  const merged = overlay.files.find(candidate => candidate.path === file);
  const caller = historical.get(file);
  assert.equal(entry.predecessorSha256, merged.sha256);
  assert.equal(caller, merged.predecessorSha256);
  assert.equal(currentOutput(file, caller), entry.sha256);
  assert.equal(entry.sha256, digest(read(file)));
  for (const alternate of [entry.predecessorSha256, entry.sha256, '0'.repeat(64)]) {
    assert.throws(() => currentOutput(file, alternate), /upstream predecessor changed/);
  }
  assert.throws(() => currentOutput(file, caller, 'normalized'), /no normalized stock proof/);
  for (const [name, mutate, pattern] of [
    ['wrong parent', value => { value.round4Successors.parentHead = '0'.repeat(40); }, /f8405a820bf9b2fae63fdffe37e0e3d2e6b163df/],
    ['wrong predecessor', value => { value.round4Successors.files[0].predecessorSha256 = '0'.repeat(64); }, /round4 predecessor changed/],
    ['original predecessor', value => { value.round4Successors.files[0].predecessorSha256 = caller; }, /round4 predecessor changed/],
    ['normalized output', value => { value.round4Successors.files[0].normalizedSha256 = 'a'.repeat(64); }, /round4 successor is raw only/],
    ['duplicate row', value => { value.round4Successors.files.push(value.round4Successors.files[0]); }, /deep-equal/],
    ['other path', value => { value.round4Successors.files[0].path = 'unreviewed.txt'; }, /deep-equal/],
    ['missing disposition', value => { value.round4Successors.files[0].note = ' '; }, /missing round4 disposition/],
    ['null output', value => { value.round4Successors.files[0].sha256 = null; }, /round4 output hash|must be of type string/],
    ['malformed output', value => { value.round4Successors.files[0].sha256 = 'invalid'; }, /round4 output hash/],
  ]) {
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
});

test('every round2 raw successor binds exact finalized current bytes through the full chain', () => {
  assert.equal(overlay.round2Successors.parentHead, '16eda5b18ba2cd764d0da0827a2e8741b12d3834');
  for (const entry of overlay.round2Successors.files) {
    assert.equal(currentOutput(entry.path, historical.get(entry.path)), entry.sha256, entry.path);
    assert.equal(digest(read(entry.path)), entry.sha256, entry.path);
  }
});
