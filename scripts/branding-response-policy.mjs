import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { c1ThemeOutputSha256 } from './branding-c1-theme.mjs';

// A separate successor ledger preserves every earlier historical field and digest unchanged.
const provenance = JSON.parse(readFileSync(new URL('../branding/http-response-policy-overlay.json', import.meta.url), 'utf8'));
const behaviorOverlay = JSON.parse(readFileSync(new URL('../branding/behavior-overlay.json', import.meta.url), 'utf8'));
const outputs = new Map(provenance.files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, provenance.files.length);
export function responsePolicyOutputSha256(file, historicalSha256) {
  const entry = outputs.get(file);
  if (!entry) return c1ThemeOutputSha256(behaviorOverlay, file, historicalSha256);
  assert.equal(entry.predecessorSha256, historicalSha256, `${file}: response-policy predecessor changed`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return c1ThemeOutputSha256(behaviorOverlay, file, entry.sha256);
}
