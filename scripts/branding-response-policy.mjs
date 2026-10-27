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
const behaviorOverlay = JSON.parse(readFileSync(new URL('../branding/behavior-overlay.json', import.meta.url), 'utf8'));
const basePathOutputs = new Map(behaviorOverlay.files.filter(entry => entry.basePathSha256)
  .map(entry => [entry.path, entry]));
const files = [...provenance.files, ...notification.files];
const outputs = new Map(files.map(entry => [entry.path, entry]));
assert.equal(outputs.size, files.length);
const basePathSha256 = entry => entry.basePathSha256;
// openchamber#649: the newest successor layers, newest first. Each records, per file, pre<Layer>CombinedSha256 (the
// binding it replaced), <layer>Sha256 (the current bytes) and <layer>Note, and its source commit at top level.
export const SUCCESSOR_LAYERS = [
  ['hostedRunner', '1ddb52bfa0589aeefaf51752cbac0e8ba066b350'],
  ['untrackedCap', 'd09665b285dddf90913ed1c1c4ef2ddbc33e2d07'],
];
const layerKeys = name => [`pre${name[0].toUpperCase()}${name.slice(1)}CombinedSha256`, `${name}Sha256`, `${name}Note`];
const successorOutputs = new Map(SUCCESSOR_LAYERS.flatMap(([name]) => behaviorOverlay.files
  .filter(entry => entry[`${name}Sha256`]).map(entry => [entry.path, [name, entry]])));
/** Removes the successor layers from a clone of the overlay: the exact preceding ledger, parsed and in bytes. */
export function unwindSuccessorLayers(historical) {
  for (const [name, source] of SUCCESSOR_LAYERS) {
    const [pre, sha, note] = layerKeys(name);
    assert.equal(historical[`${name}Source`], source, `${name}: source commit`);
    delete historical[`${name}Source`];
    for (const entry of historical.files.filter(candidate => sha in candidate)) {
      assert.equal(entry[sha], entry.combinedSha256, `${entry.path}: ${name} is the current binding`);
      assert.match(entry[pre], /^[a-f0-9]{64}$/, entry.path);
      assert.ok(entry[note], `${entry.path}: missing ${name} disposition`);
      entry.combinedSha256 = entry[pre];
      for (const key of [pre, sha, note]) delete entry[key];
    }
  }
  return historical;
}
export function responsePolicyOutputSha256(file, historicalSha256) {
  const successor = successorOutputs.get(file);
  if (successor) {
    const [name, entry] = successor;
    const historicalHashes = Object.entries(entry).filter(([key]) => key.endsWith('Sha256')).map(([, value]) => value);
    assert.ok(historicalHashes.includes(historicalSha256), `${file}: unrecognized predecessor in the ${name} ledger`);
    return entry[`${name}Sha256`];
  }
  const basePath = basePathOutputs.get(file);
  if (basePath) {
    assert.match(basePathSha256(basePath), /^[a-f0-9]{64}$/);
    const historicalHashes = Object.entries(basePath).filter(([key, value]) => key.endsWith('Sha256') && typeof value === 'string').map(([, value]) => value);
    assert.ok(historicalHashes.includes(historicalSha256), `${file}: unrecognized predecessor in the base-path ledger`);
    assert.ok(basePath.basePathNote, `${file}: missing base-path successor disposition`);
    return basePath.basePathSha256;
  }
  const entry = outputs.get(file);
  if (!entry) return historicalSha256;
  assert.equal(entry.predecessorSha256, historicalSha256, `${file}: response-policy predecessor changed`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.note, `${file}: missing successor disposition`);
  return entry.sha256;
}
