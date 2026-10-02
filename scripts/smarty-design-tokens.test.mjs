import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const vendorDirectory = new URL('../packages/ui/src/styles/vendor/smarty-design-system/', import.meta.url);

test('vendored Smarty tokens match the SHA-256 pin in provenance', () => {
  const provenance = readFileSync(new URL('PROVENANCE.md', vendorDirectory), 'utf8');
  const checksums = [...provenance.matchAll(/^- SHA-256: `([a-f0-9]{64})`$/gm)];
  assert.equal(checksums.length, 1, 'provenance must contain exactly one vendored SHA-256 pin');

  const css = readFileSync(new URL('tokens.css', vendorDirectory));
  const actual = createHash('sha256').update(css).digest('hex');
  assert.equal(actual, checksums[0][1], 'vendored tokens.css drifted from the provenance pin');
});
