import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A separate successor ledger preserves every earlier historical field and digest unchanged.
const provenance = JSON.parse(readFileSync(new URL('../branding/http-response-policy-overlay.json', import.meta.url), 'utf8'));
// Keep the six response-policy owners intact; bind the separate notification successor exactly.
const notification = provenance.notificationProvenance;
assert.equal(notification.issue, 'smarty-code#1264 / openchamber#535');
assert.equal(notification.sourceHead, 'edfae2b912c4533c4b785da4c4ed071953f7758f');
assert.equal(notification.baseHead, 'd41518e48463b6231653def3585a3a59ad2ef870');
assert.ok(notification.note, 'missing notification successor provenance');
assert.deepEqual(notification.files.map(entry => [entry.path, entry.predecessorSha256, entry.sha256]), [
  ['packages/web/src/api/notifications.ts',
    '4ff0ddccb7eac46e3dec481ca462be3bdb1fe670d276a60109ce0d4ca1cbff49',
    '69d78c11a89c7ac2893d35aa0847fd3058fe63307297aeb53a421bd43ef81b23'],
]);
const files = [...provenance.files, ...notification.files];
const outputs = new Map(files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, files.length);
export function responsePolicyOutputSha256(file, historicalSha256) {
  const entry = outputs.get(file);
  if (!entry) return historicalSha256;
  assert.equal(entry.predecessorSha256, historicalSha256, `${file}: response-policy predecessor changed`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return entry.sha256;
}
