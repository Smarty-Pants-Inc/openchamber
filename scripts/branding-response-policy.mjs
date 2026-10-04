import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Separate successor ledgers preserve every earlier historical field and digest unchanged.
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
const json = file => JSON.parse(read(file));
const provenance = json('branding/http-response-policy-overlay.json');
const upstream = json('branding/upstream-v1.24.2-overlay.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const merge = upstream.mergeSuccessors;
assert.equal(merge.sourceHead, '32ec1d2975b5e9dc8ab899da3a2e6e898afef602');
assert.deepEqual(merge.parents, [
  '0abf901ea521eaf47d54f9641c1ed7740a5e2f8c',
  '36ccd44b4069a1ca283854ae7613f673ded3f80a',
]);
assert.equal(merge.baseBehaviorLedgerSha256, 'e6baee9f1cc443a6cceadcc75dd75a98f54ae6f838cbde226ef2e3ab2a3fbe0f');
// Four exact merge rows, including both tray branches. Never restamp an older layer.
assert.equal(digest(JSON.stringify(merge)), '2b11d05eb10c63dec2dcdf855992585eaa293decf198f5a9cd5b21a8d1feb59a', 'merge proof changed');
const behavior = json('branding/behavior-overlay.json');
assert.equal(digest(read('branding/behavior-overlay.json')), merge.baseBehaviorLedgerSha256, 'base behavior ledger changed');
const baseOutputs = new Map(behavior.files.filter(entry => entry.sessionStatusReadSha256).map(entry => [entry.path, entry]));
const historicalBehavior = structuredClone(behavior);
historicalBehavior.files = historicalBehavior.files.filter(entry => !entry.sessionStatusReadAdded);
for (const entry of historicalBehavior.files.filter(entry => entry.preSessionStatusReadCombinedSha256)) {
  entry.combinedSha256 = entry.preSessionStatusReadCombinedSha256;
  delete entry.preSessionStatusReadCombinedSha256;
  delete entry.sessionStatusReadSha256;
  delete entry.sessionStatusReadNote;
}
delete historicalBehavior.sessionStatusReadProvenance;
const ledgerPins = {
  'branding/coverage.json': '10838b01de0e37e7deb6085d7097bfa4699eb71fef0f96ef6d0e1cdf605722df',
  'branding/behavior-overlay.json': '42cb0bcc611bd57ca55b84ac94f08906385546ab7f8f39ccadc27dcb6bc4c8e5',
  'branding/stock-owner-parity.json': 'e432dc759a1b79c9d6e4d6f85d749aa47f1df98cfc8232970b8913e851da4102',
  'branding/http-response-policy-overlay.json': '0d07d352bad0275e0afd4e98b28bf338478736a962feac35cfaaf137129c454a',
};
assert.equal(upstream.baseHead, 'd41518e48463b6231653def3585a3a59ad2ef870');
assert.equal(upstream.upstreamHead, '614d7f76e581a132a86575c03d3fa9aad5e624b6');
assert.deepEqual(upstream.predecessorLedgers, ledgerPins);
for (const [file, digest] of Object.entries(ledgerPins)) {
  const bytes = file === 'branding/behavior-overlay.json' ? `${JSON.stringify(historicalBehavior, null, 2)}\n` : read(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${file}: historical ledger changed`);
}
const predecessors = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry.outputSha256]));
for (const entry of historicalBehavior.files) predecessors.set(entry.path, entry.combinedSha256);
const originalInputs = new Map(predecessors);
const outputs = new Map(provenance.files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, provenance.files.length);
for (const entry of outputs.values()) {
  assert.equal(entry.predecessorSha256, predecessors.get(entry.path), `${entry.path}: response-policy predecessor changed`);
  predecessors.set(entry.path, entry.sha256);
}
const stockOutputs = new Map(json('branding/stock-owner-parity.json').files.map(entry => [entry.path, entry]));
const upstreamOutputs = new Map(upstream.files.map(entry => [entry.path, entry]));
assert.ok(upstreamOutputs.size, 'missing upstream merge outputs');
assert.equal(upstreamOutputs.size, upstream.files.length, 'duplicate upstream merge output');
for (const entry of upstreamOutputs.values()) {
  assert.ok(predecessors.has(entry.path), `${entry.path}: no historical proof to extend`);
  assert.equal(entry.predecessorSha256, predecessors.get(entry.path), `${entry.path}: upstream predecessor changed`);
  assert.match(entry.note, /\S/, `${entry.path}: missing upstream disposition`);
  const stock = stockOutputs.get(entry.path);
  if (stock?.normalize.length) {
    assert.equal(entry.normalizedPredecessorSha256, stock.stockSha256, `${entry.path}: normalized predecessor changed`);
  } else {
    assert.equal('normalizedPredecessorSha256' in entry || 'normalizedSha256' in entry, false, `${entry.path}: no normalized stock proof to extend`);
  }
}
const review = upstream.reviewSuccessors;
assert.equal(review.predecessorHead, '74503e43955b13a5b49731417f0efeae8748a702');
assert.equal(review.reviewedHead, '4f86403ec77539242efd27c8a87884fcd5b5184e');
const reviewOutputs = new Map(review.files.map(entry => [entry.path, entry]));
assert.ok(reviewOutputs.size, 'missing reviewed raw outputs');
assert.equal(reviewOutputs.size, review.files.length, 'duplicate reviewed raw output');
for (const entry of reviewOutputs.values()) {
  assert.ok(predecessors.has(entry.path), `${entry.path}: no historical proof to extend`);
  assert.equal(entry.predecessorSha256, upstreamOutputs.get(entry.path)?.sha256 ?? predecessors.get(entry.path), `${entry.path}: reviewed predecessor changed`);
  assert.match(entry.note, /\S/, `${entry.path}: missing reviewed disposition`);
  assert.equal('normalizedPredecessorSha256' in entry || 'normalizedSha256' in entry, false, `${entry.path}: reviewed successor is raw only`);
}
const round2 = upstream.round2Successors;
assert.equal(round2.parentHead, '16eda5b18ba2cd764d0da0827a2e8741b12d3834');
const round2Outputs = new Map(round2.files.map(entry => [entry.path, entry]));
assert.ok(round2Outputs.size, 'missing round2 raw outputs');
assert.equal(round2Outputs.size, round2.files.length, 'duplicate round2 raw output');
for (const entry of round2Outputs.values()) {
  assert.ok(predecessors.has(entry.path), `${entry.path}: no historical proof to extend`);
  assert.equal('normalizedPredecessorSha256' in entry || 'normalizedSha256' in entry, false, `${entry.path}: round2 successor is raw only`);
  assert.ok(!stockOutputs.get(entry.path)?.normalize.length, `${entry.path}: round2 cannot extend a normalized stock path`);
  assert.match(entry.predecessorSha256, /^[a-f0-9]{64}$/, `${entry.path}: invalid round2 predecessor hash`);
  assert.equal(entry.predecessorSha256, reviewOutputs.get(entry.path)?.sha256 ?? upstreamOutputs.get(entry.path)?.sha256 ?? predecessors.get(entry.path), `${entry.path}: round2 predecessor changed`);
  assert.match(entry.note, /\S/, `${entry.path}: missing round2 disposition`);
  // Prepared null outputs remain inspectable, but the raw resolver below rejects any byte claim.
  if (entry.sha256 !== null) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `${entry.path}: round2 output hash must be finalized after writer release`);
  }
}
const round4 = upstream.round4Successors;
assert.equal(round4.parentHead, 'f8405a820bf9b2fae63fdffe37e0e3d2e6b163df');
assert.deepEqual(round4.files.map(entry => entry.path), ['packages/ui/src/lib/worktreeSessionCreator.ts']);
const round4Outputs = new Map(round4.files.map(entry => [entry.path, entry]));
for (const entry of round4Outputs.values()) {
  assert.equal(entry.predecessorSha256, round2Outputs.get(entry.path)?.sha256 ?? reviewOutputs.get(entry.path)?.sha256 ?? upstreamOutputs.get(entry.path)?.sha256 ?? predecessors.get(entry.path), `${entry.path}: round4 predecessor changed`);
  assert.equal('normalizedPredecessorSha256' in entry || 'normalizedSha256' in entry, false, `${entry.path}: round4 successor is raw only`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/, `${entry.path}: round4 output hash must bind frozen current bytes`);
  assert.match(entry.note, /\S/, `${entry.path}: missing round4 disposition`);
}
const mergeOutputs = new Map(merge.files.map(entry => [entry.path, entry]));
for (const entry of mergeOutputs.values()) {
  const base = baseOutputs.get(entry.path);
  assert.equal(entry.basePredecessorSha256, base?.combinedSha256, `${entry.path}: merge base predecessor changed`);
  assert.equal(entry.predecessorSha256, round4Outputs.get(entry.path)?.sha256 ?? round2Outputs.get(entry.path)?.sha256 ?? reviewOutputs.get(entry.path)?.sha256 ?? upstreamOutputs.get(entry.path)?.sha256 ?? predecessors.get(entry.path) ?? base?.combinedSha256, `${entry.path}: merge predecessor changed`);
  assert.ok(!stockOutputs.get(entry.path)?.normalize.length, `${entry.path}: merge successor is raw only`);
}
const rawSuccessors = [['response-policy', outputs], ['upstream', upstreamOutputs], ['reviewed', reviewOutputs], ['round2', round2Outputs], ['round4', round4Outputs], ['merge', mergeOutputs]];
export function responsePolicyOutputSha256(file, historicalSha256, context = 'raw') {
  assert.ok(context === 'raw' || context === 'normalized', `${file}: unsupported output context`);
  if (context === 'normalized') {
    const stock = stockOutputs.get(file);
    assert.ok(stock?.normalize.length, `${file}: no normalized stock proof to extend`);
    assert.equal(historicalSha256, stock.stockSha256, `${file}: normalized predecessor changed`);
    const entry = upstreamOutputs.get(file);
    if (!entry) return historicalSha256;
    assert.match(entry.normalizedSha256, /^[a-f0-9]{64}$/, `${file}: normalized upstream output hash must be finalized after writer release`);
    return entry.normalizedSha256;
  }
  const base = baseOutputs.get(file);
  if (base && historicalSha256 === base.combinedSha256) {
    return mergeOutputs.get(file)?.sha256 ?? base.combinedSha256;
  }
  if (base && !originalInputs.has(file)) {
    assert.equal(historicalSha256, base.combinedSha256, `${file}: base predecessor changed`);
  }
  const originalSha256 = historicalSha256;
  let extended = false;
  for (const [layer, entries] of rawSuccessors) {
    const entry = entries.get(file);
    if (!entry) continue;
    extended = true;
    assert.equal(entry.predecessorSha256, historicalSha256, `${file}: ${layer} predecessor changed`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `${file}: ${layer} output hash must be finalized after writer release`);
    assert.match(entry.note, /\S/, `${file}: missing successor disposition`);
    historicalSha256 = entry.sha256;
  }
  if (!extended) {
    assert.ok(originalInputs.has(file), `${file}: no historical proof`);
    assert.equal(originalSha256, originalInputs.get(file), `${file}: original predecessor changed`);
  }
  return historicalSha256;
}
