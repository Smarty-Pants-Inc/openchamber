import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectedOwnerOverlay, selectedOwnerRepairOverlay as repair, selectedOwnerRepairOutputSha256 as repairOutput, selectedOwnerOutputSha256 as currentOutput, unwindSelectedOwner } from './branding-selected-owner.mjs';
import { responsePolicyOutputSha256 } from './branding-response-policy.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
// Copied from the frozen smarty-code#1427 parent-native receipt, .local/r4c-sync-owned-native-export.json.
// Never learned from the candidate ledger or filesystem; no Git object dependency.
const inventory = [
  ['M', 'packages/ui/src/components/chat/ChatInput.coSteer.test.tsx', 'a951906af4de6b3af81c4f6638086c4d4f2219e0', 'c59dbdcab0aaf2cbbc6e7a0e0374b2aa487f7f82',
    '873e6840da280b691c5e97bed17220f77883e048d62182b75f404284ed3214ea', '5eafd17a4c1eae3519bb444502dd782b0437828335696155e4741812e21b66c8',
    'Align co-steer recovery cases with the session fence: no second POST while a Send is unconfirmed.'],
  ['M', 'packages/ui/src/components/chat/ChatInput.dueRecovery.test.tsx', 'bcf6de087c8740ee0d72e5ef9c8e9ca4fabadb30', 'b77aa594115b9c2ab0541948ad248d23da7ead84',
    'c92fa717c84ad04f1643eafa6533a5a8197509cf7cf5f51fa05d3e466eeebc8b', '19a055d136895ff005816e16db478360d2e00519227aa4da88bf6959f88930a1',
    'Align due-recovery cases with the session fence: one held Send plus an unsent draft.'],
  ['M', 'packages/ui/src/components/chat/ChatInput.tsx', '45915224a1e1faddf0ebf9941cf1424244125895', 'fce1fc2ba9f0998424079ea6b87fde5de6d82dd6',
    'a0a4f0ba205211310b14c7896be2753120b467b86cfa8fbcab5d5922257fae51', '039dea87fc6a37fd804a36bbc3bdad76f6705dc7ef85c03dba1cf13f7362415e',
    'Read sync-owned session confirmation state while keeping editor restoration local; remount cannot grant Send.'],
  ['M', 'packages/ui/src/components/chat/composer/DOCUMENTATION.md', '90fc706a4d564a5a1303ab5ca5572516e85bd405', '1a1441b05f15bd5165d96c9cc56df6882aebb57d',
    '03c380abadf5d90fc32e7f894a36612d1e0f4ea83e9d2e0f56135c047213389d', '22e3b1f53cc09c252fc519fdfe2b1a245868c031b4c45f57a121332bd944505e',
    'Document sync-owned confirmation lifetime across composer replacement, owner moves and known-outcome release.'],
  ['M', 'packages/ui/src/components/chat/composer/state/useComposerDraft.ts', 'a016acfef2c108e95982c945dd6005c1d77c4aae', '795c8717aa9f7ea0b167e89a2968cdfcdf68d08c',
    '6db0f47b705ab38d5e365ccddc1b379578c8feb0a21c4bc58de60707eb2c6011', '842c701a5ed447c9aa409f81b0c479ede079a07baed0c2c5a556d3fb6d03cc47',
    'Transfer live editor and pending-send recovery identity through the verified owner-move boundary.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerDraft.test.tsx', null, '33b0a27a6d8f267222738b1e5227dc3a674f2b2a',
    null, '6d9e623637b5c1123daaf7057709c03f3ee91856140db129e2f680794ab58425',
    'Add actual composer move, input, mention, conflict and runtime isolation regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerHistoryRecovery.test.tsx', null, '61b0f5cfd806fc8fb175f64b5c0041ac33b63301',
    null, '9a6e837c1abb1218f9acb8e9259f7221a74bc10b97d6351910e5bde36fbbd73e',
    'Exercise actual composer Send after quiet transport recovery with retained history and unchanged connection.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerRecovery.test.tsx', null, '26627b193be461ec9e1727de9b835ae6ca181e14',
    null, 'f1391bdaa0924064a0f182759d94f43790cd6e4e9875c08468a9c35c330491b1',
    'Cover held outcomes through mounted composer and view-only replacement, runtime isolation, owner moves and explicit release.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/ordinaryBootstrapAdmission.test.tsx', null, 'a00e2d86bb256a37bad47438af185d4c4bf0c151',
    null, '56045df5e485c0134ec8c4f216ed778f0f48b78d0bf7ec76b611c40599b75236',
    'Mounted regression: a global-only ordinary owner reserves before directory bootstrap and across remount.'],
  ['M', 'packages/ui/src/lib/i18n/messages/send-pending.i18n.ts', 'b4c0e24cbfc6be4f610b6eb8463aa28716637ec2', '98dddb5102a16c8b590d9f30405f38221dc2c2b0',
    'd04be9f1bbc45074632468f67295764c891bc3a3977489942382b30a11d3287e', '76d2e6e44ac430661e27079120a304e33f896572e032e37af87f28dd0eda92a8',
    'Translate the session confirmation wait reason in all twelve supported locales.'],
  ['M', 'packages/ui/src/lib/opencode/client.ts', '31cac0fbd07bbda7e8fc3f6ee453debd0d23502a', '2b4f8755ff1d3d72df73f4d405280c5bccc39ab2',
    '7b4e033afb0b9bade634184cad7e517fedec14f7998550604ac5e4c119706ce8', 'b40b4488bd8a06ff12bc9c328c9d76435ec4b67a74e3eba741900df2bd15435d',
    'Carry route-admitted ordinary ownership into prompt history loading and give slash commands the final admission check.'],
  ['M', 'packages/ui/src/lib/sendRecovery.test.ts', '9fedb39b999a1c2ff654e4b4ee8307b68f9c0f29', '1c286c434509fb3497d0594cd03ef83db570353a',
    'a311ecf41a20c64cfbb88e9f89ae2d75a8c98a3af019298f65efc1b15a201d8d', '1bf8127e585085356dc1e17e5ab68f8e50ea742e3b5dc880f34bbd1127e3ae93',
    'Cover collision lifetime, session-wide admission, runtime isolation, reservation conflicts and known-outcome release.'],
  ['M', 'packages/ui/src/lib/sendRecovery.ts', '49dcb5175e4bf1ae173d0997ec6eecc39cf16a0e', '7818486395ceb1746730958c4ad27662c118a72f',
    '52951b3496998d573a7b319a76632aafb895c9d13d4ae6a281935fb0fa78da42', '3948d3e8a8a9515931f275132f99b99f65dd65040cc386916d877adf866e5757',
    'Retain colliding reservations and atomically fence session admission until every outcome is known, independent of owner directory or input identity.'],
  ['M', 'packages/ui/src/sync/DOCUMENTATION.md', '16d18c486a11185137809abd0787bb3f48157ddf', '836c36f09d69b35c6ad095e0e39507a4feb35a42',
    '6389b1f0557422c63ff009f08ae4803265c315cd3ecae6e94d3233b0da6664e4', 'dc905f70bd9bf707f3f2ea81f5d93076fd4ef2ad79160f95a767896fcefe76de',
    'Document bounded quiet history recovery, verified owner transfer and browser-lifetime sync-owned Send confirmation.'],
  ['M', 'packages/ui/src/sync/__tests__/issue-2039.test.ts', 'e36c09042954387cf3948994463f2755fc46fd74', '95814db6d18fae63492d9d29e242030e08fa52e8',
    '8e3f78cc062ced51015dd3f310fc9c8bbbd40cc8f822ded2a37d55c2a0fa90c6', '17cd3c3e2b16f6d37307840a7ae0908eb729e62e5ee026c862f1d9f99b96aeff',
    'Keep the legacy draft fixture mock complete for Send admission imports and reject unexpected owner adoption.'],
  ['A', 'packages/ui/src/sync/ordinary-admission-sources.test.ts', null, '143dc82e6e5da03d618264e7b1d07bc87ba3310e',
    null, 'b45f3e07aacba17d15077e2e409dd3bee4598e14a34aa415ff0ef71a817ac46c',
    'Route regressions for every ordinary admission source, directory capture, command dispatch and stock concurrency.'],
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
  ['M', 'packages/ui/src/sync/selected-session-owner.ts', 'ce7cbb896495c684366f2142d63683500ce9d88f', 'e3eb976bd9c38a97786274f801a3edc1af77e04b',
    '221b108f351debd719658dae76ebcd16084e06b140e28abfe5bcc5dc36712ec0', '6d1e7f4cf9ee9d95ff9db4f5f23a970d32117ca72d9237dc9f72d6d52dcfd276',
    'Classify ordinary Send admission from selected-owner state, every directory row, the global listing before bootstrap and accepted loader views.'],
  ['M', 'packages/ui/src/sync/session-actions.ts', 'd4b8d10de9af28d33d1c44055c7effda713830f8', 'a722d19661225e1a461a80b333423a033f6c04b2',
    '8c21cfa4d50b1e4552af2baeba5660fe8ac651d1619062fd3b6a25a740dcdc5b', '723d026fcecd41fb3600c59eaba481356ad98c3751e62da1e6344f3cd54940a1',
    'Check destination draft conflict before verified owner reconciliation can invalidate history or change attribution.'],
  ['A', 'packages/ui/src/sync/session-send-state.test.ts', null, '766f199c4d6030f0d0d45a48619de09780c49fde',
    null, 'fd90f1dbd2b5fbba8dadbd50897336289e3ac4ef5f331b0a0de18d0b1a440d3b',
    'Prove store-owned admission, pending and ambiguous lifetime, runtime isolation, captured settlement and known-outcome release.'],
  ['A', 'packages/ui/src/sync/session-send-state.ts', null, 'f0ce6544a52d1dafa408f533326bb27a8501caa7',
    null, 'e06fc00d9fa6d584e6b8007024db301a9124c44890730d76c87f4508338cec9a',
    'Own pending Send outcomes by runtime and session outside composer lifetime, with atomic admission and authoritative settlement.'],
  ['M', 'packages/ui/src/sync/session-ui-store.ts', '3d7cee981131ddb9010b022d9e69609b8e9e4d94', '78191a2dfba8e6d4846f5238473f0e43302d7eb9',
    '01275f06e310e110e13b1b03a08042fbbfe6796efe0eecfea1f8ae5688618093', 'd339d82172cb304a2c96b823770b4c8f166003733fad75c18b4da2219a0c261c',
    'Own ordinary Send admission and outcome settlement through the sync state module and dynamic SDK dispatch fence.'],
  ['M', 'packages/ui/src/sync/sync-refs.ts', 'ccc236f22d0f8943a4e26997868346cc208fcc2d', '06e4001ce1eff89350d9e82f61f3be4cb6d6ea59',
    '2b5ed4f8ed58d8b3ce80104ddd4806da03e83dbe41d6d5cfefd843701cfb50c6', '14fa547ed238bd0dfd8d2b0616d8a9457a06c0b6b171caaa0cc5fefd1d528918',
    'Read every child store row for one session ID, so a stock duplicate cannot mask another directory ordinary row.'],
];
const expected = {
  schemaVersion: 1, pullRequest: 549, issue: 'smarty-code#1378',
  baseHead: '11796181f2f7341730e3a467b347bdd0470b0642', sourceTreePath: 'packages/ui',
  sourceTree: '56f3ad1c581ae779110c4caf752896e6fea215b7', objectFormat: 'sha1',
  predecessorLedgerSha256: '976e08cc78ac5585b68ffc51e79b59d7d66b2e3b2eafd12286c5540851cde78b',
  predecessorLedgerBytesSha256: '25d8427aca66ccd894d0ce1a62467b0d79b37033b4fd3f9fd9db6a31b1283fc1',
  scope: inventory.map(([status, path]) => ({ status, path })),
  files: inventory.map(([status, path, predecessorBlob, blob, predecessorSha256, sha256, note]) => ({
    status, path, predecessorBlob, blob, predecessorMode: status === 'A' ? null : '100644', mode: '100644', predecessorSha256, sha256, note,
  })),
  note: 'Parent-native export of the frozen PR549 round-4, sync-owned confirmation and smarty-code#1427 admission repair: 29 UI files, 18 modified and 11 added. sourceTree is the packages/ui Git subtree, excluding branding and scripts. Blob IDs and byte SHA256 are separate. Source inventory only; final native subtree binding, review, CI, full UI and same-Pi browser proof remain parent-owned gates.',
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

test('repair pins exact native subtree metadata, all twenty-nine rows and independent current byte hashes', () => {
  const before = JSON.stringify(repair);
  assertInventory(repair);
  assert.equal(expected.files.length, 29);
  assert.equal(expected.files.filter(entry => entry.status === 'M').length, 18);
  assert.equal(expected.files.filter(entry => entry.status === 'A').length, 11);
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
