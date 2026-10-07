import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Successor ledger for the Node-mode member execution refusal (smarty-code#1356): each entry names the exact
// predecessor output it replaces. Earlier ledgers and their digests stay unchanged.
const ledger = JSON.parse(readFileSync(new URL('../branding/node-member-execution-overlay.json', import.meta.url), 'utf8'));
const outputs = new Map(ledger.files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, ledger.files.length);

export function nodeMemberExecutionOutputSha256(file, predecessorSha256) {
  const entry = outputs.get(file);
  if (!entry) return predecessorSha256;
  assert.equal(entry.predecessorSha256, predecessorSha256, `${file}: Node member execution predecessor changed`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return entry.sha256;
}
