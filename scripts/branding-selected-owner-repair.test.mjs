import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectedOwnerOverlay, selectedOwnerRepairOverlay as repair, selectedOwnerRepairOutputSha256 as repairOutput, selectedOwnerOutputSha256 as currentOutput, unwindSelectedOwner } from './branding-selected-owner.mjs';
import { responsePolicyOutputSha256 } from './branding-response-policy.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
// Copied from the frozen round-4/security parent-native receipt, SHA256 17dadb0b.
// Never learned from the candidate ledger or filesystem; no Git object dependency.
const inventory = [
  ['M', 'packages/ui/src/components/chat/ChatInput.tsx', '45915224a1e1faddf0ebf9941cf1424244125895', '6f2e45a900da3bafd8c6c2fd9b0892e140be2a23',
    'a0a4f0ba205211310b14c7896be2753120b467b86cfa8fbcab5d5922257fae51', 'ca06443f2ae4567b5057e8dae4c2853abb099a0d1056b072d5cdbde6fc63a092',
    'Transfer pending recovery target and owned input only after verified same-session owner adoption.'],
  ['M', 'packages/ui/src/components/chat/composer/DOCUMENTATION.md', '90fc706a4d564a5a1303ab5ca5572516e85bd405', 'f63bb8d703c736f92793ab53d52907bdc85cfd2d',
    '03c380abadf5d90fc32e7f894a36612d1e0f4ea83e9d2e0f56135c047213389d', 'e372648aa2a5096b9a5adad4bf7307997e66c496b552abab3fb91baba4de9e54',
    'Document verified owner transfer and collision blocking until every Send outcome is accounted for.'],
  ['M', 'packages/ui/src/components/chat/composer/state/useComposerDraft.ts', 'a016acfef2c108e95982c945dd6005c1d77c4aae', '795c8717aa9f7ea0b167e89a2968cdfcdf68d08c',
    '6db0f47b705ab38d5e365ccddc1b379578c8feb0a21c4bc58de60707eb2c6011', '842c701a5ed447c9aa409f81b0c479ede079a07baed0c2c5a556d3fb6d03cc47',
    'Transfer live editor and pending-send recovery identity through the verified owner-move boundary.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerDraft.test.tsx', null, '33b0a27a6d8f267222738b1e5227dc3a674f2b2a',
    null, '6d9e623637b5c1123daaf7057709c03f3ee91856140db129e2f680794ab58425',
    'Add actual composer move, input, mention, conflict and runtime isolation regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerHistoryRecovery.test.tsx', null, '61b0f5cfd806fc8fb175f64b5c0041ac33b63301',
    null, '9a6e837c1abb1218f9acb8e9259f7221a74bc10b97d6351910e5bde36fbbd73e',
    'Exercise actual composer Send after quiet transport recovery with retained history and unchanged connection.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerRecovery.test.tsx', null, '2770e2a4a1048556fa25f839adda4d4892ba2c77',
    null, '694d4dee5e585cfbd842e249a7c555c0c7c3e366c29f67ea6b9978eb3497812e',
    'Cover held POST moves, offscreen recovery collisions, retry blocking, preserved callbacks and one synthetic native admission.'],
  ['M', 'packages/ui/src/lib/sendRecovery.test.ts', '9fedb39b999a1c2ff654e4b4ee8307b68f9c0f29', 'adbc181b7a0a6a2e8d56e1133966067d435dc69c',
    'a311ecf41a20c64cfbb88e9f89ae2d75a8c98a3af019298f65efc1b15a201d8d', 'b9326eeb9d5717c9d3e9ed94ada4d96c8e1df599c7220ac1869af3fa47ff38ad',
    'Cover offscreen owner collisions, all settlement orders, reservation conflicts, later moves and safe same-ID retries.'],
  ['M', 'packages/ui/src/lib/sendRecovery.ts', '49dcb5175e4bf1ae173d0997ec6eecc39cf16a0e', '94456897742cef074705806ea1225455515968a0',
    '52951b3496998d573a7b319a76632aafb895c9d13d4ae6a281935fb0fa78da42', 'd5b0a8fbac911b2665ecb59158f327a9fa932a5aa0ef5fc378ea406e55945b12',
    'Preserve all colliding recovery groups, client IDs and unresolved reservations through verified owner moves; block retries until settlement.'],
  ['M', 'packages/ui/src/sync/DOCUMENTATION.md', '16d18c486a11185137809abd0787bb3f48157ddf', '5b0a9b84bec562a07524ec1b0ec6d7bc3c722a91',
    '6389b1f0557422c63ff009f08ae4803265c315cd3ecae6e94d3233b0da6664e4', 'b2500f9fddea9bd6138aa505dc6d059e302a771ddf6667d485e460acf6217a7f',
    'Document bounded quiet history recovery and verified pending submission ownership transfer.'],
  ['M', 'packages/ui/src/sync/__tests__/issue-2039.test.ts', 'e36c09042954387cf3948994463f2755fc46fd74', '374c93c4ec31a25075aa7a6ca03e6a17eb8de130',
    '8e3f78cc062ced51015dd3f310fc9c8bbbd40cc8f822ded2a37d55c2a0fa90c6', '8c341c7ec6e506b2db5241f88e9c1b816f494de3533942cdec59ba429dca68ab',
    'Keep legacy draft fixture exports compatible with the provider-scoped owner imports and reject unexpected owner adoption.'],
  ['A', 'packages/ui/src/sync/selected-owner-cold-ended.test.tsx', null, '3d31027c481c4d3adc8fd9f9e5f23d9a825c3328',
    null, '0d29afdcf5336137e8b8f0cdd22a2a9857f0954856c57f2c8bfb45b3cbdf7d09',
    'Add cold persisted ended-owner checking before parent refs are published; no historical predecessor.'],
  ['A', 'packages/ui/src/sync/selected-owner-cold-provider.test.tsx', null, '81d0f5c94c8a726ded6cdaa2d5f0e80ca0cfc484',
    null, '664dc2eefd6834b9fa79af02d65783233614a806a7d87c3e8fd4294d3cf059b4',
    'Add native provider subscription, cold and StrictMode mount and scoped cleanup regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/sync/selected-owner-history-recovery.test.tsx', null, 'c509804b547c055827a36451a08ac7db281839ed',
    null, '5ec52e8f7347d42a764f6465c1ce3a99fa5b781da1f645ea4859c334bf1947e4',
    'Cover exhausted transport failures, quiet HTTP recovery, permanent-failure bounds and current native authority.'],
  ['M', 'packages/ui/src/sync/selected-owner-operation.ts', '472264eda3936d8e0429c3e74ec05a4185fb3daf', '14cb04e9ac9ecbb348e64606bb51a593e8956edd',
    '0148bc55c040385b3da4ba15bf687f0c653ba730e4669de5d91bd7c2a70b3f8c', 'b2c566553fac8f53aed34c46a051a993380512b13da799b4d2148de7f5884b9e',
    'Bind owner checks to captured provider child stores and refuse adoption after provider replacement.'],
  ['M', 'packages/ui/src/sync/selected-owner-react-fixture.tsx', '680dee585b340afa80d3f6e9c18dee297050d4c8', 'a6b47b8a9c1bac31c6d59b060455ca41deca64dc',
    '33cbd8f68e5f31c6cc9ef10831ee157cc2d9b2392889bf1a1be39ecc036a7ac9', '4ddc115870358d67722fb4b43c5b02baa00aedf54f2caa9c7a1a84cc22078bd5',
    'Mount owner probes inside the native sync runtime context with fixture-owned child stores and loader.'],
  ['A', 'packages/ui/src/sync/selected-owner-title-recovery.test.tsx', null, '976f4bf1d3798f8f43a5cbec4b12b942a7f51767',
    null, '00898eb97ec7554d68fde44380b2e556b8cda21a0887f018afdb24b084134738',
    'Add title invalidation and fresh detail success or 503 recovery regressions; no historical predecessor.'],
  ['M', 'packages/ui/src/sync/selected-session-owner.test.tsx', '3f7df0b617269dfe293e472dd3a96a3c8353e78c', '48c1eb50d62a2b0bca6ad1e94c96797fcf5a6515',
    'a713218dcdab1ff73a40a7f1ee0bc7845df05b0840b0ca0bbdaffa71b3932383', '923d72fd89c0f86fdf1e9e444baac70d54011ffccbe46cd068510160cdde58d5',
    'Run the existing mounted owner recovery regression within its native sync runtime provider.'],
  ['M', 'packages/ui/src/sync/selected-session-owner.ts', 'ce7cbb896495c684366f2142d63683500ce9d88f', '709c8b02da1a415fd96da3386afae87839f3f3c3',
    '221b108f351debd719658dae76ebcd16084e06b140e28abfe5bcc5dc36712ec0', 'd959164c33d77e1ea8795bbf54fa6956cccce2b7e6b5132e99e013cfaea9c7be',
    'Bound a replacement check for unusable established live history without requiring reconnect or catalog change.'],
  ['M', 'packages/ui/src/sync/session-actions.ts', 'd4b8d10de9af28d33d1c44055c7effda713830f8', 'a722d19661225e1a461a80b333423a033f6c04b2',
    '8c21cfa4d50b1e4552af2baeba5660fe8ac651d1619062fd3b6a25a740dcdc5b', '723d026fcecd41fb3600c59eaba481356ad98c3751e62da1e6344f3cd54940a1',
    'Check destination draft conflict before verified owner reconciliation can invalidate history or change attribution.'],
  ['M', 'packages/ui/src/sync/session-ui-store.ts', '3d7cee981131ddb9010b022d9e69609b8e9e4d94', '4ab9448c657bba62da474acf28afb7025b6bd3e4',
    '01275f06e310e110e13b1b03a08042fbbfe6796efe0eecfea1f8ae5688618093', '085cc4e5f2efe83c67ef6dd1fb287e812e4516e8fec2983877c9ef21fa93e868',
    'Arm and consume only the selected verified same-session draft transfer under runtime and reveal revision fences.'],
];
const expected = {
  schemaVersion: 1, pullRequest: 549, issue: 'smarty-code#1378',
  baseHead: '11796181f2f7341730e3a467b347bdd0470b0642', sourceTreePath: 'packages/ui',
  sourceTree: 'c257d60579e3d4935bf3c9f18ccaed263c49ca6a', objectFormat: 'sha1',
  predecessorLedgerSha256: '976e08cc78ac5585b68ffc51e79b59d7d66b2e3b2eafd12286c5540851cde78b',
  predecessorLedgerBytesSha256: '25d8427aca66ccd894d0ce1a62467b0d79b37033b4fd3f9fd9db6a31b1283fc1',
  scope: inventory.map(([status, path]) => ({ status, path })),
  files: inventory.map(([status, path, predecessorBlob, blob, predecessorSha256, sha256, note]) => ({
    status, path, predecessorBlob, blob, predecessorMode: status === 'A' ? null : '100644', mode: '100644', predecessorSha256, sha256, note,
  })),
  note: 'Parent-native export of the frozen PR549 round-4 and security collision repair: 20 UI files, 13 modified and 7 added. sourceTree is the packages/ui Git subtree, excluding branding and scripts. Blob IDs and byte SHA256 are separate. Source inventory only; final native subtree binding, review, CI, full UI and same-Pi browser proof remain parent-owned gates.',
};
function assertInventory(candidate, readSource = read, ledgerBytes = read('branding/behavior-overlay.json')) {
  assert.deepEqual(candidate, expected);
  assert.equal(digest(ledgerBytes), expected.predecessorLedgerBytesSha256, 'exact historical ledger bytes');
  const ledger = JSON.parse(ledgerBytes);
  assert.equal(ledger.files.length, 66);
  assert.equal(digest(JSON.stringify(ledger)), expected.predecessorLedgerSha256, 'complete historical ledger');
  const historical = unwindSelectedOwner(ledger);
  assert.equal(historical.files.length, 48);
  assert.equal(digest(JSON.stringify(historical)), '8fec0501cecd9fe031e9bd6ca9a8f3b7dd8c7f049005b17985778957deea4e0e');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), 'e6baee9f1cc443a6cceadcc75dd75a98f54ae6f838cbde226ef2e3ab2a3fbe0f');
  for (const entry of expected.files) {
    assert.match(entry.note, /\S/);
    assert.equal(digest(readSource(entry.path)), entry.sha256, `${entry.path}: frozen repair bytes`);
    const old = ledger.files.find(owner => owner.path === entry.path);
    if (old) assert.equal(entry.predecessorSha256, old.combinedSha256, `${entry.path}: preserved ownership chain`);
  }
}

test('repair pins exact native subtree metadata, all twenty rows and independent current byte hashes', () => {
  const before = JSON.stringify(repair);
  assertInventory(repair);
  assert.equal(expected.files.length, 20);
  assert.equal(expected.files.filter(entry => entry.status === 'M').length, 13);
  assert.equal(expected.files.filter(entry => entry.status === 'A').length, 7);
  assert.equal(JSON.stringify(repair), before);
});

test('inventory refuses false pins, blobs, hashes, modes, scope and pending or malformed dispositions', () => {
  const reject = change => { const copy = structuredClone(repair); change(copy); assert.throws(() => assertInventory(copy)); };
  for (const key of ['schemaVersion', 'pullRequest', 'issue', 'baseHead', 'sourceTree', 'sourceTreePath', 'objectFormat', 'predecessorLedgerSha256', 'predecessorLedgerBytesSha256', 'note']) {
    for (const value of [null, '', ' ', '0'.repeat(40)]) reject(copy => { copy[key] = value; });
  }
  reject(copy => { copy.sourceHead = expected.baseHead; });
  reject(copy => { copy.qualificationHead = expected.baseHead; });
  for (const key of ['scope', 'files']) {
    reject(copy => { copy[key].pop(); });
    reject(copy => { copy[key].push({ ...copy[key][0], path: 'packages/ui/extra.ts' }); });
    reject(copy => { copy[key].push(copy[key][0]); });
    reject(copy => { copy[key].reverse(); });
    for (const path of ['../escape.ts', '/packages/ui/escape.ts', 'packages/ui/../escape.ts']) reject(copy => { copy[key][0].path = path; });
    reject(copy => { copy[key][0].status = 'D'; });
  }
  for (const [index, entry] of expected.files.entries()) {
    for (const key of ['blob', 'sha256', 'mode', 'note', 'predecessorBlob', 'predecessorSha256', 'predecessorMode']) {
      for (const value of [null, '', ' ', '0'.repeat(64), '0'.repeat(40), '100755', {}]) {
        if (value !== entry[key]) reject(copy => { copy.files[index][key] = value; });
      }
    }
  }
});

test('byte drift and old ledger tampering fail without writing source or mutating inputs', () => {
  const drift = file => Buffer.concat([read(file), Buffer.from('\n')]);
  for (const entry of expected.files) assert.throws(() => assertInventory(repair, file => file === entry.path ? drift(file) : read(file)), /frozen repair bytes/);
  const uncovered = selectedOwnerOverlay.files.find(entry => entry.path === 'packages/ui/src/components/chat/ChatContainer.tsx');
  assert.equal(digest(read(uncovered.path)), repairOutput(uncovered.path, uncovered.selectedOwnerSha256));
  assert.throws(() => assert.equal(digest(drift(uncovered.path)), repairOutput(uncovered.path, uncovered.selectedOwnerSha256)));
  const tampered = structuredClone(selectedOwnerOverlay);
  tampered.files[0].behaviorSha256 = '0'.repeat(64);
  assert.throws(() => assertInventory(repair, read, Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`)), /historical ledger bytes/);
  assert.throws(() => unwindSelectedOwner(tampered), /predecessor ledger/);
});

test('terminal mapping retains historical guards, additions stay inventory and double application fails', () => {
  const before = JSON.stringify([repair, selectedOwnerOverlay]);
  for (const entry of expected.files.filter(row => row.status === 'M')) {
    assert.equal(repairOutput(entry.path, entry.predecessorSha256), entry.sha256);
    const oldHash = entry.path.endsWith('/session-ui-store.ts') ? '81b57a1b36d565997ccd163d6a4214fa30161c79a49ed798ecfb226e253c207b' : entry.predecessorSha256;
    assert.equal(currentOutput(entry.path, oldHash), entry.sha256);
    assert.throws(() => repairOutput(entry.path, '0'.repeat(64)), /predecessor changed/);
    assert.throws(() => repairOutput(entry.path, entry.sha256), /predecessor changed/);
    assert.throws(() => currentOutput(entry.path, entry.sha256), /predecessor changed/);
  }
  for (const entry of expected.files.filter(row => row.status === 'A')) assert.equal(repairOutput(entry.path, 'inventory-not-parity'), 'inventory-not-parity');
  const policies = JSON.parse(read('branding/http-response-policy-overlay.json'));
  for (const entry of policies.files) {
    assert.equal(currentOutput(entry.path, entry.predecessorSha256), entry.sha256);
    assert.equal(currentOutput(entry.path, entry.predecessorSha256), responsePolicyOutputSha256(entry.path, entry.predecessorSha256));
    assert.equal(digest(read(entry.path)), entry.sha256);
    assert.throws(() => currentOutput(entry.path, '0'.repeat(64)), /response-policy predecessor changed/);
  }
  assert.equal(currentOutput('not-an-owner', 'unrelated'), 'unrelated');
  assert.equal(JSON.stringify([repair, selectedOwnerOverlay]), before);
});

test('the repair adapter itself refuses blank dispositions and invalid current hashes', () => {
  const entry = repair.files.find(row => row.status === 'M');
  const before = JSON.stringify(repair), { note, sha256 } = entry;
  try {
    for (const value of [null, '', ' ', {}]) {
      entry.note = value;
      assert.throws(() => repairOutput(entry.path, entry.predecessorSha256), /disposition/);
    }
    entry.note = note;
    for (const value of [null, '', '0'.repeat(40)]) {
      entry.sha256 = value;
      assert.throws(() => repairOutput(entry.path, entry.predecessorSha256));
    }
  } finally { entry.note = note; entry.sha256 = sha256; }
  assert.equal(JSON.stringify(repair), before);
});
