import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectedOwnerOverlay as overlay, unwindSelectedOwner, selectedOwnerOutputSha256 } from './branding-selected-owner.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
// Parent-exported Git name-status and actual2547 bytes. These are fixed expected
// values, not hashes learned from the candidate ledger or current filesystem.
const expected = [
  ['A', 'packages/ui/src/components/chat/365-mounted-ended-continue.test.tsx', '8c255e92916d1f1bc7a80b09c661b83bb1af960a248f11b8ce00e16da686602c'],
  ['M', 'packages/ui/src/components/chat/ChatContainer.tsx', '6eaedf42eb729d1b155d1c6c1702088fa744ba7e98d4aee5b2a1e1ddf7841584'],
  ['M', 'packages/ui/src/components/chat/ChatInput.tsx', 'a0a4f0ba205211310b14c7896be2753120b467b86cfa8fbcab5d5922257fae51'],
  ['M', 'packages/ui/src/lib/openOrdinaryState.ts', '668bb56e1b66a925e12b46e67ddf3643dad830888f6cd58b0cd8d012aa7645fa'],
  ['A', 'packages/ui/src/lib/runtime-auth-generation.test.ts', '5ceebf0138a713c84473c4146fd030b4b1a680e0384cf7826397236f825b41f3'],
  ['M', 'packages/ui/src/lib/runtime-auth.ts', '6156b1906968b984b81a5a83137b539ba2ff8f163890b5a0f888cc1c4370b71a'],
  ['M', 'packages/ui/src/sync/DOCUMENTATION.md', '6389b1f0557422c63ff009f08ae4803265c315cd3ecae6e94d3233b0da6664e4'],
  ['A', 'packages/ui/src/sync/selected-owner-destination.test.ts', 'defe6284dadf9db0f128fdc59cf1275d496418c58ce51ab75dc46eaf7932fb66'],
  ['A', 'packages/ui/src/sync/selected-owner-lifecycle.test.tsx', 'e8ba49972ae6cb9db60b65f2887f62fbfc924abfdddad3a00aeff4bf7a650a06'],
  ['A', 'packages/ui/src/sync/selected-owner-native-cas.test.ts', '051f785dd186f3a7b36ddd89f5342cbc2196ac50e71d9d68b39d3f499c0e59ee'],
  ['A', 'packages/ui/src/sync/selected-owner-operation.ts', '0148bc55c040385b3da4ba15bf687f0c653ba730e4669de5d91bd7c2a70b3f8c'],
  ['A', 'packages/ui/src/sync/selected-owner-react-fixture.tsx', '33cbd8f68e5f31c6cc9ef10831ee157cc2d9b2392889bf1a1be39ecc036a7ac9'],
  ['A', 'packages/ui/src/sync/selected-owner-review-fixture.ts', '4741391c46a3ea1335c8ed2616f71b50d0fd01709f734ee45afc829976d202f8'],
  ['A', 'packages/ui/src/sync/selected-owner-routing.test.ts', '453b3f0e85d0749b1d533e2fe7390440a36a264373aa09e721df1c9e3dca7864'],
  ['A', 'packages/ui/src/sync/selected-owner-supersession.test.tsx', 'ccd0280624f9cf8c69a1f3d850ffd47bcf6afbdb4883e991cde584f71d451849'],
  ['A', 'packages/ui/src/sync/selected-session-owner.test.tsx', 'a713218dcdab1ff73a40a7f1ee0bc7845df05b0840b0ca0bbdaffa71b3932383'],
  ['A', 'packages/ui/src/sync/selected-session-owner.ts', '221b108f351debd719658dae76ebcd16084e06b140e28abfe5bcc5dc36712ec0'],
  ['M', 'packages/ui/src/sync/session-actions.ts', '8c21cfa4d50b1e4552af2baeba5660fe8ac651d1619062fd3b6a25a740dcdc5b'],
  ['M', 'packages/ui/src/sync/session-ui-store.ts', '01275f06e310e110e13b1b03a08042fbbfe6796efe0eecfea1f8ae5688618093'],
];
const store = 'packages/ui/src/sync/session-ui-store.ts';
const predecessor = '81b57a1b36d565997ccd163d6a4214fa30161c79a49ed798ecfb226e253c207b';

function assertInventory(candidate, readSource = read) {
  const provenance = candidate.selectedOwnerProvenance;
  assert.deepEqual(provenance, {
    pullRequest: 549,
    issue: 'smarty-code#1378',
    baseHead: '47531865f388d1c2a4e8b2ec331bb9b05b0ffc46',
    sourceHead: '2547fddaff3a764f56a3c1f3fd9c7b58952a181a',
    predecessorLedgerSha256: '8fec0501cecd9fe031e9bd6ca9a8f3b7dd8c7f049005b17985778957deea4e0e',
    predecessorLedgerBytesSha256: 'e6baee9f1cc443a6cceadcc75dd75a98f54ae6f838cbde226ef2e3ab2a3fbe0f',
    scope: expected.map(([status, path]) => ({ status, path })),
    note: 'Parent-exported exact Git base-to-source scope:19 total files,12 added and7 modified. Source head2547 includes the ended-owner correction. This is behavior provenance, not a security pass, exact-head CI, native/browser proof or release acceptance.',
  });
  assert.equal(expected.length, 19);
  assert.equal(expected.filter(([status]) => status === 'A').length, 12);
  assert.equal(expected.filter(([status]) => status === 'M').length, 7);
  assert.equal(new Set(candidate.files.map(entry => entry.path)).size, candidate.files.length);
  const owners = new Map(candidate.files.map(entry => [entry.path, entry]));
  assert.deepEqual(candidate.files.filter(entry => 'selectedOwnerSha256' in entry).map(entry => entry.path).sort(), expected.map(([, file]) => file).sort());
  assert.deepEqual(candidate.files.filter(entry => entry.selectedOwnerAdded).map(entry => entry.path), expected.filter(([, file]) => file !== store).map(([, file]) => file));
  const donor = new Set(JSON.parse(read('branding/coverage.json')).files.map(entry => entry.path));
  for (const [, file, hash] of expected) {
    const entry = owners.get(file);
    assert.equal(entry.selectedOwnerSha256, hash, file);
    assert.equal(entry.combinedSha256, hash, file);
    assert.equal(digest(readSource(file)), hash, `${file}: frozen source bytes`);
    if (file === store) {
      assert.equal(entry.preSelectedOwnerCombinedSha256, predecessor);
      assert.equal(entry.personalSidebarRevealSha256, predecessor);
      assert.equal(entry.selectedOwnerAdded, undefined);
      assert.ok(entry.selectedOwnerNote);
      assert.equal(donor.has(file), true);
    } else {
      assert.equal(entry.selectedOwnerAdded, true, file);
      assert.equal(entry.behaviorSha256, hash, file);
      assert.equal(entry.brandingSha256, undefined, file);
      assert.equal(entry.preSelectedOwnerCombinedSha256, undefined, file);
      assert.equal(donor.has(file), false, file);
      assert.ok(entry.reason, file);
    }
  }
}

test('PR549 binds all nineteen actual source files, including the ended-owner correction, without claiming stock parity', () => {
  assertInventory(overlay);
});

test('selected-owner unwind restores the complete exact base before either historical ledger suite', () => {
  const before = JSON.stringify(overlay);
  const historical = unwindSelectedOwner(overlay);
  assert.equal(historical.files.length, 48);
  assert.equal(digest(JSON.stringify(historical)), '8fec0501cecd9fe031e9bd6ca9a8f3b7dd8c7f049005b17985778957deea4e0e');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), 'e6baee9f1cc443a6cceadcc75dd75a98f54ae6f838cbde226ef2e3ab2a3fbe0f');
  assert.equal(JSON.stringify(overlay), before);
  assert.throws(() => selectedOwnerOutputSha256(store, '0'.repeat(64)), /predecessor changed/);
  assert.equal(selectedOwnerOutputSha256('not-an-owner', predecessor), predecessor);
});

test('selected-owner guards reject source drift, false hashes, wrong scope and mutated historical evidence', () => {
  const mutate = change => { const copy = structuredClone(overlay); change(copy); return copy; };
  const owner = copy => copy.files.find(entry => entry.path === store);
  assert.throws(() => assertInventory(overlay, file => file === store ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file)), /frozen source bytes/);
  assert.throws(() => assertInventory(mutate(copy => { owner(copy).selectedOwnerSha256 = '0'.repeat(64); })));
  assert.throws(() => assertInventory(mutate(copy => { copy.selectedOwnerProvenance.scope.pop(); })));
  assert.throws(() => assertInventory(mutate(copy => { copy.selectedOwnerProvenance.sourceHead = copy.selectedOwnerProvenance.baseHead; })));
  assert.throws(() => unwindSelectedOwner(mutate(copy => { owner(copy).nativeCreationSha256 = '0'.repeat(64); })), /predecessor ledger/);
  assert.throws(() => unwindSelectedOwner(mutate(copy => { owner(copy).preSelectedOwnerCombinedSha256 = '0'.repeat(64); })));
});
