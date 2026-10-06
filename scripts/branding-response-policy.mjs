import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostPowerDeletionOutputSha256 } from './branding-host-power-deletion.mjs';

// A separate successor ledger preserves every earlier historical field and digest unchanged.
const provenance = JSON.parse(readFileSync(new URL('../branding/http-response-policy-overlay.json', import.meta.url), 'utf8'));
const outputs = new Map(provenance.files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, provenance.files.length);
// The host-power deletion ledger is the next successor: current output = deletion(policy(historical)).
export function responsePolicyOutputSha256(file, historicalSha256) {
  const entry = outputs.get(file);
  if (!entry) return hostPowerDeletionOutputSha256(file, historicalSha256);
  assert.equal(entry.predecessorSha256, historicalSha256, `${file}: response-policy predecessor changed`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return hostPowerDeletionOutputSha256(file, entry.sha256);
}
