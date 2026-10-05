import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { responsePolicyOutputSha256 } from './branding-response-policy.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const store = 'packages/ui/src/sync/session-ui-store.ts';
const predecessor = '81b57a1b36d565997ccd163d6a4214fa30161c79a49ed798ecfb226e253c207b';
const successor = '01275f06e310e110e13b1b03a08042fbbfe6796efe0eecfea1f8ae5688618093';
const parsedBase = '8fec0501cecd9fe031e9bd6ca9a8f3b7dd8c7f049005b17985778957deea4e0e';
const bytesBase = 'e6baee9f1cc443a6cceadcc75dd75a98f54ae6f838cbde226ef2e3ab2a3fbe0f';
export const selectedOwnerOverlay = JSON.parse(readFileSync(new URL('../branding/behavior-overlay.json', import.meta.url), 'utf8'));

// Both historical suites remove this layer before examining any earlier fields.
export function unwindSelectedOwner(input) {
  const historical = structuredClone(input);
  const provenance = historical.selectedOwnerProvenance;
  assert.equal(provenance.sourceHead, '2547fddaff3a764f56a3c1f3fd9c7b58952a181a');
  assert.equal(provenance.baseHead, '47531865f388d1c2a4e8b2ec331bb9b05b0ffc46');
  assert.equal(provenance.predecessorLedgerSha256, parsedBase);
  assert.equal(provenance.predecessorLedgerBytesSha256, bytesBase);
  const overlaps = historical.files.filter(entry => entry.preSelectedOwnerCombinedSha256);
  assert.deepEqual(overlaps.map(entry => entry.path), [store]);
  const entry = overlaps[0];
  assert.equal(entry.preSelectedOwnerCombinedSha256, predecessor);
  assert.equal(entry.selectedOwnerSha256, successor);
  assert.equal(entry.combinedSha256, successor);
  entry.combinedSha256 = entry.preSelectedOwnerCombinedSha256;
  delete entry.preSelectedOwnerCombinedSha256;
  delete entry.selectedOwnerSha256;
  delete entry.selectedOwnerNote;
  historical.files = historical.files.filter(file => !file.selectedOwnerAdded);
  delete historical.selectedOwnerProvenance;
  assert.equal(historical.files.length, 48);
  assert.equal(digest(JSON.stringify(historical)), parsedBase, 'complete selected-owner predecessor ledger');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), bytesBase, 'exact predecessor ledger bytes');
  return historical;
}

// Only the existing store is a successor of a historical owner. The eighteen
// other records are ordinary source inventory, never blanket branding parity.
export function selectedOwnerOutputSha256(file, historicalSha256) {
  if (file !== store) return responsePolicyOutputSha256(file, historicalSha256);
  const entry = selectedOwnerOverlay.files.find(owner => owner.path === store);
  assert.equal(historicalSha256, predecessor, `${file}: selected-owner predecessor changed`);
  assert.equal(entry.preSelectedOwnerCombinedSha256, predecessor);
  assert.equal(entry.selectedOwnerSha256, successor);
  assert.equal(entry.combinedSha256, successor);
  return successor;
}
