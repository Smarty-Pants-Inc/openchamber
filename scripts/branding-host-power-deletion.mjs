import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Successor ledger for the host-power deletion (smarty-code#1398): ledger-tracked files that the
// deletion changed or removed. Each entry names the exact predecessor output it replaces and the
// new output (null when the file was deleted). Earlier ledgers and their digests stay unchanged.
const ledger = JSON.parse(readFileSync(new URL('../branding/host-power-deletion-overlay.json', import.meta.url), 'utf8'));
const outputs = new Map(ledger.files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, ledger.files.length);

export function hostPowerDeletionOutputSha256(file, predecessorSha256) {
  const entry = outputs.get(file);
  if (!entry) return predecessorSha256;
  assert.equal(entry.predecessorSha256, predecessorSha256, `${file}: host-power deletion predecessor changed`);
  assert.ok(entry.sha256 === null || /^[a-f0-9]{64}$/.test(entry.sha256), `${file}: invalid successor digest`);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return entry.sha256;
}
