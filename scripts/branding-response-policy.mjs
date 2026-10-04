import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Separate successor ledgers preserve every earlier historical field and digest unchanged.
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
const json = file => JSON.parse(read(file));
const provenance = json('branding/http-response-policy-overlay.json');
const upstream = json('branding/upstream-v1.24.2-overlay.json');
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
  assert.equal(createHash('sha256').update(read(file)).digest('hex'), digest, `${file}: historical ledger changed`);
}
const predecessors = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry.outputSha256]));
for (const entry of json('branding/behavior-overlay.json').files) predecessors.set(entry.path, entry.combinedSha256);
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
const rawSuccessors = [['response-policy', outputs], ['upstream', upstreamOutputs], ['reviewed', reviewOutputs], ['round2', round2Outputs]];
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
  for (const [layer, entries] of rawSuccessors) {
    const entry = entries.get(file);
    if (!entry) continue;
    assert.equal(entry.predecessorSha256, historicalSha256, `${file}: ${layer} predecessor changed`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `${file}: ${layer} output hash must be finalized after writer release`);
    assert.match(entry.note, /\S/, `${file}: missing successor disposition`);
    historicalSha256 = entry.sha256;
  }
  return historicalSha256;
}
