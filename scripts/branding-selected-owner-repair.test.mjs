import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectedOwnerOverlay, selectedOwnerRepairOverlay as repair, selectedOwnerRepairOutputSha256 as repairOutput, selectedOwnerOutputSha256 as currentOutput, unwindSelectedOwner } from './branding-selected-owner.mjs';
import { responsePolicyOutputSha256 } from './branding-response-policy.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(new URL(`../${file}`, import.meta.url));
// Copied from the independently native-exported parent receipt, SHA256 bfce2367.
// Never learned from the candidate ledger or filesystem; no Git object dependency.
const inventory = [
  ['M', 'packages/ui/src/components/chat/ChatInput.coSteer.test.tsx', 'a951906af4de6b3af81c4f6638086c4d4f2219e0', 'c59dbdcab0aaf2cbbc6e7a0e0374b2aa487f7f82',
    '873e6840da280b691c5e97bed17220f77883e048d62182b75f404284ed3214ea', '5eafd17a4c1eae3519bb444502dd782b0437828335696155e4741812e21b66c8',
    'Align co-steer recovery cases with one Send at a time per session.'],
  ['M', 'packages/ui/src/components/chat/ChatInput.dueRecovery.test.tsx', 'bcf6de087c8740ee0d72e5ef9c8e9ca4fabadb30', 'b77aa594115b9c2ab0541948ad248d23da7ead84',
    'c92fa717c84ad04f1643eafa6533a5a8197509cf7cf5f51fa05d3e466eeebc8b', '19a055d136895ff005816e16db478360d2e00519227aa4da88bf6959f88930a1',
    'Align due-recovery cases with one Send at a time per session.'],
  ['M', 'packages/ui/src/components/chat/ChatInput.tsx', '45915224a1e1faddf0ebf9941cf1424244125895', '0245be064d671ee491fcca3ac4e9e15248e3e23b',
    'a0a4f0ba205211310b14c7896be2753120b467b86cfa8fbcab5d5922257fae51', 'e71ff3a2a4737d91eb1be2d8d4166f28e3bbcf6d9de408820e2fd5d35f812f8f',
    'Read Send admission from the sync layer and resend an unresolved message only with its original client ID.'],
  ['M', 'packages/ui/src/components/chat/composer/DOCUMENTATION.md', '90fc706a4d564a5a1303ab5ca5572516e85bd405', 'e6452e2721d3a532d9484a550112e2f3d02e3a07',
    '03c380abadf5d90fc32e7f894a36612d1e0f4ea83e9d2e0f56135c047213389d', '28b136cfb9e653c9c99fa5775f0e1e8ae6e4e7403a7ea59976ddd21fe55a7927',
    'Document sync-owned Send admission and same-ID retry for the composer.'],
  ['M', 'packages/ui/src/components/chat/composer/state/useComposerDraft.ts', 'a016acfef2c108e95982c945dd6005c1d77c4aae', '252ba27c7ead35322e59d83684f8c506fd200351',
    '6db0f47b705ab38d5e365ccddc1b379578c8feb0a21c4bc58de60707eb2c6011', '096c5816df984028cca6032338682e947628a1182876d080b7d54e46e6425495',
    'Retain live input through verified moves and prevent page-only conflict submissions from writing the destination draft.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerDraft.test.tsx', null, '33b0a27a6d8f267222738b1e5227dc3a674f2b2a',
    null, '6d9e623637b5c1123daaf7057709c03f3ee91856140db129e2f680794ab58425',
    'Add actual composer move, input, mention, conflict and runtime isolation regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerHistoryRecovery.test.tsx', null, '75e68f5ece19a93d87dc3df6af5b84e09280d6e6',
    null, 'c301e403105ce3d7bf58d56cfb877f21e5f7a6a597dc7f74eefb51b61ea96d0f',
    'Exercise mounted Send after quiet transport recovery and the bounded recheck budget with Send fenced.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/observedOwnerRecovery.test.tsx', null, '5bf7323e0570a7218eb1484b410113869a6a6981',
    null, 'e0217cf79af1d79fe36fbbbce6078b676c8dcdfad6c400748271772353d9d641',
    'Add failed send and late accepted cleanup regressions for protected and ordinary drafts; no historical predecessor.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/ordinaryBootstrapAdmission.test.tsx', null, '877bce71412eda941494da16ad55fc8767c830eb',
    null, 'f885d961520c48398bc678754f1c8192317b6b04115cdd1e3dbc6cb3f563af7e',
    'Mounted regression: a global-only ordinary owner reserves before directory bootstrap and across remount.'],
  ['A', 'packages/ui/src/components/chat/composer/submit/__tests__/sendAdmissionRetry.test.tsx', null, '9e9b87f79985eb116964db782ff1b00968ba39cf',
    null, '64b3300b37ed34577411e8f06e77ee9f89482552c5ad24742429ccf8e74b80d5',
    'Mounted regression: an ambiguous Send admits its same-ID retry, which settles the outcome and frees the session.'],
  ['M', 'packages/ui/src/lib/i18n/messages/send-pending.i18n.ts', 'b4c0e24cbfc6be4f610b6eb8463aa28716637ec2', '98dddb5102a16c8b590d9f30405f38221dc2c2b0',
    'd04be9f1bbc45074632468f67295764c891bc3a3977489942382b30a11d3287e', '76d2e6e44ac430661e27079120a304e33f896572e032e37af87f28dd0eda92a8',
    'Translate the wait reason for an unresolved Send in all twelve locales.'],
  ['M', 'packages/ui/src/lib/openOrdinaryState.ts', 'eb3fc8ea696da0e362027f47df8def908943ab9f', '10c29379df6e9d1fa62246790c92e0eb61e619ef',
    '668bb56e1b66a925e12b46e67ddf3643dad830888f6cd58b0cd8d012aa7645fa', 'aa75dc5a2295ba45155e8acdaae3dcec1ebbf6f8e3a82409f9024cb93a43f6bd',
    'One ordinary classification and model source for the composer, the Send route and its final dispatch checks.'],
  ['M', 'packages/ui/src/lib/opencode/client.ts', '31cac0fbd07bbda7e8fc3f6ee453debd0d23502a', 'f38c5c705e85f38c41704219d81b8a3be219e478',
    '7b4e033afb0b9bade634184cad7e517fedec14f7998550604ac5e4c119706ce8', 'a1038049a47661e0136c039bb0a86027d5488adcbb9fe8ef2a3a1704627bb135',
    'Carry route-admitted ordinary ownership into history loading and give commands and shell the final admission check.'],
  ['M', 'packages/ui/src/lib/sendRecovery.ts', '49dcb5175e4bf1ae173d0997ec6eecc39cf16a0e', '2d1c4fc7f73550ac226c3a2c9bbc06c83a6f0bae',
    '52951b3496998d573a7b319a76632aafb895c9d13d4ae6a281935fb0fa78da42', '29a9e5449d39916e3e1539ab11862922936bcab8f948cb546d540c3bb14a4b54',
    'Let a retry of a send left unresolved elsewhere keep its original client ID.'],
  ['M', 'packages/ui/src/stores/useProjectsStore.ts', 'c71b12389407d2892392b785479937c10bd3439b', 'c566b7b1228bc9e00325374819337959475efaaa',
    '6a7acd43d59360f7603249b5d2864929be7235dba7707da50755d2670633f653', '14793555872f97204370510b4ed24ee0365412cf8bdabebb6e2f8f288ff9d98d',
    'Keep managedRows identity when a catalog refresh republishes unchanged rows (smarty-code#1392).'],
  ['M', 'packages/ui/src/sync/DOCUMENTATION.md', '16d18c486a11185137809abd0787bb3f48157ddf', '26914ba53c851fdb45e0c37070f8fe86cf490e5f',
    '6389b1f0557422c63ff009f08ae4803265c315cd3ecae6e94d3233b0da6664e4', '78891aa4f3e5c65ea3ecb418a215efa1a288b36ec3852da634cd8d80911dc499',
    'Document bounded owner recovery, catalog feedback, and ordinary Send admission with its single model source.'],
  ['M', 'packages/ui/src/sync/__tests__/issue-2039.test.ts', 'e36c09042954387cf3948994463f2755fc46fd74', '95814db6d18fae63492d9d29e242030e08fa52e8',
    '8e3f78cc062ced51015dd3f310fc9c8bbbd40cc8f822ded2a37d55c2a0fa90c6', '17cd3c3e2b16f6d37307840a7ae0908eb729e62e5ee026c862f1d9f99b96aeff',
    'Keep the legacy draft fixture mock complete for Send admission imports.'],
  ['M', 'packages/ui/src/sync/event-pipeline.ts', 'eb206bb51f2703249dcc19958253ae4098b5cf5e', '98fafcc5269bfda396d7b9261fa071d6300a294b',
    '9d87b5ab85a813addcbecbddbddf58bbdfd4aa6fa647871b6aee694e306eb916', 'ef83bf30af29b49210456961d528e48dcb8f9dfeaa7e33fe07018e91796b2a22',
    'Emit the transport-readiness signal on every connect and on a WS to SSE transport switch.'],
  ['M', 'packages/ui/src/sync/native-draft-recovery.test.ts', 'a219bc427d2a5cda78b0efef2181edf064b224e0', '2ffd237630c50019afd3bb7a55ff28c2e739dd34',
    'e2b1e45f9545f5d1ce5ca32bbfc5f2ac50afc92cc6da7d809f071b65996b2e2d', '01d766508848b102fa44669fde509ce30b7a8680c3d13b57f7df37e03427539a',
    'Account for the ordinary session Send lock held alongside the native request lock.'],
  ['A', 'packages/ui/src/sync/ordinary-admission-sources.test.ts', null, '2fa82c70331ef839a9e8183a79a1c4c9ddd28284',
    null, '13e1c1c3d6da563ab8c6ea0c16084d81904b06ae663fba7505307de2e5232d02',
    'Route regressions for every ordinary classification source, directory capture, command and shell dispatch, and availability.'],
  ['A', 'packages/ui/src/sync/selected-owner-catalog-feedback.test.tsx', null, '8fd5d21807059a4da787ad5dd0afc7c17f633cc0',
    null, '98e864f942116a8c87e3d630b1c8228f86488e4245ca389860c6057849e4faee',
    'Unchanged catalog republication after a 503 does not retrigger the owner check (smarty-code#1392).'],
  ['A', 'packages/ui/src/sync/selected-owner-cold-ended.test.tsx', null, '3d31027c481c4d3adc8fd9f9e5f23d9a825c3328',
    null, '0d29afdcf5336137e8b8f0cdd22a2a9857f0954856c57f2c8bfb45b3cbdf7d09',
    'Add cold persisted ended-owner checking before parent refs are published; no historical predecessor.'],
  ['A', 'packages/ui/src/sync/selected-owner-cold-provider.test.tsx', null, '81d0f5c94c8a726ded6cdaa2d5f0e80ca0cfc484',
    null, '664dc2eefd6834b9fa79af02d65783233614a806a7d87c3e8fd4294d3cf059b4',
    'Add native provider subscription, cold and StrictMode mount and scoped cleanup regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/sync/selected-owner-equal-observation.test.tsx', null, 'b3111a24dc245359f772f14382072c1b47e1b853',
    null, '3976ceedbb21c0e5bcf9ad8f7926c551f1eea4e197024fd3f1a967b529efbd1d',
    'A same-ID time-only update during a held check gets one bounded replacement check (smarty-code#1414).'],
  ['A', 'packages/ui/src/sync/selected-owner-history-recovery.test.tsx', null, 'c509804b547c055827a36451a08ac7db281839ed',
    null, '5ec52e8f7347d42a764f6465c1ce3a99fa5b781da1f645ea4859c334bf1947e4',
    'Cover exhausted transport failures, quiet HTTP recovery, permanent-failure bounds and current native authority.'],
  ['M', 'packages/ui/src/sync/selected-owner-operation.ts', '472264eda3936d8e0429c3e74ec05a4185fb3daf', 'a38fc7cac23d1a309c71fadc9155b9626ea5238b',
    '0148bc55c040385b3da4ba15bf687f0c653ba730e4669de5d91bd7c2a70b3f8c', '9abff557c27ed9476b58eb5c822cdd705cc774dd56eeb17327c6719e0b64e56b',
    'Own the transport-readiness signal and one bounded replacement for an equal same-ID observation.'],
  ['M', 'packages/ui/src/sync/selected-owner-react-fixture.tsx', '680dee585b340afa80d3f6e9c18dee297050d4c8', 'a6b47b8a9c1bac31c6d59b060455ca41deca64dc',
    '33cbd8f68e5f31c6cc9ef10831ee157cc2d9b2392889bf1a1be39ecc036a7ac9', '4ddc115870358d67722fb4b43c5b02baa00aedf54f2caa9c7a1a84cc22078bd5',
    'Mount owner probes inside the native sync runtime context with fixture-owned child stores and loader.'],
  ['M', 'packages/ui/src/sync/selected-owner-routing.test.ts', 'd7ce9462edeeb7fe9cf078662e71b3d9f1f3e766', '447cfcbd21a66ae4db9f1c09c7a2bf7c54c510b9',
    '453b3f0e85d0749b1d533e2fe7390440a36a264373aa09e721df1c9e3dca7864', '45f9894c78c505395b7f40a7d0a6400750b006a923b568d41bc98d29a3992077',
    'Check that a generation change during preparation refuses at the route model check.'],
  ['A', 'packages/ui/src/sync/selected-owner-title-recovery.test.tsx', null, '976f4bf1d3798f8f43a5cbec4b12b942a7f51767',
    null, '00898eb97ec7554d68fde44380b2e556b8cda21a0887f018afdb24b084134738',
    'Add title invalidation and fresh detail success or 503 recovery regressions; no historical predecessor.'],
  ['A', 'packages/ui/src/sync/selected-owner-transport-recovery.test.tsx', null, '77175d4a31f05f35ab0fa9dfe35195752bcf0802',
    null, 'f7c15c4386540b0632dbaf4835d22130322644a1b6d47f1fcdc036c5a3b12507',
    'Transport-readiness signal and bounded recheck budget recover an unknown owner without polling.'],
  ['M', 'packages/ui/src/sync/selected-session-owner.test.tsx', '3f7df0b617269dfe293e472dd3a96a3c8353e78c', '48c1eb50d62a2b0bca6ad1e94c96797fcf5a6515',
    'a713218dcdab1ff73a40a7f1ee0bc7845df05b0840b0ca0bbdaffa71b3932383', '923d72fd89c0f86fdf1e9e444baac70d54011ffccbe46cd068510160cdde58d5',
    'Run the existing mounted owner recovery regression within its native sync runtime provider.'],
  ['M', 'packages/ui/src/sync/selected-session-owner.ts', 'ce7cbb896495c684366f2142d63683500ce9d88f', 'c848fb1fc633f79e5d3b7c8a73bca792a76da64f',
    '221b108f351debd719658dae76ebcd16084e06b140e28abfe5bcc5dc36712ec0', 'edc7afcd54340b664c98c50ebc99d3871be098f978ad4c0e1653a66d76e4127b',
    'Recover an unknown owner on transport readiness or a bounded recheck budget, mutated only in committed effects.'],
  ['A', 'packages/ui/src/sync/send-admission-route.test.ts', null, '4f8c1c6b7026f342d150afb1164a1956c7b3430c',
    null, '09450a635211017eff212cc9986ffe1909051306ffbc2afab0f81d3422e91f45',
    'Route regressions: atomic admission, same-ID retry release, native model pin and revalidation, loader-only refusal, stock concurrency.'],
  ['A', 'packages/ui/src/sync/send-admission.test.ts', null, 'eb393e7e95098824ddf77f51e4f5acf3dbdb0ba3',
    null, 'c7affc8951be56acbe8f3a1aef611395d278d77faba70c875158e0fd8740cb43',
    'Cover admission, same-ID retry after an ambiguous outcome, known release, cross-tab lock and marker, and runtime isolation.'],
  ['A', 'packages/ui/src/sync/send-admission.ts', null, '17da44f86522eac6bc1fd893bb92151fe418953c',
    null, 'f02c70b28395173a53550f96a4b6dbc8e1504129b0d02dabc8118eb12fcc71c2',
    'Admit one ordinary Send per runtime and session across tabs: page claim, Web Lock, unresolved marker and same-ID retry.'],
  ['M', 'packages/ui/src/sync/session-actions.ts', 'd4b8d10de9af28d33d1c44055c7effda713830f8', 'a722d19661225e1a461a80b333423a033f6c04b2',
    '8c21cfa4d50b1e4552af2baeba5660fe8ac651d1619062fd3b6a25a740dcdc5b', '723d026fcecd41fb3600c59eaba481356ad98c3751e62da1e6344f3cd54940a1',
    'Check destination draft conflict before verified owner reconciliation can invalidate history or change attribution.'],
  ['M', 'packages/ui/src/sync/session-ui-store.ts', '3d7cee981131ddb9010b022d9e69609b8e9e4d94', '27041aa60fd0efd7506ea22b830b3de80983d642',
    '01275f06e310e110e13b1b03a08042fbbfe6796efe0eecfea1f8ae5688618093', '49794447dc6cb249ba762c916920b8ceb9b39dd931bd343c4e55a5693dc95bed',
    'Route ordinary Sends through cross-tab admission with the pinned native model rechecked before every request.'],
  ['M', 'packages/ui/src/sync/sync-refs.ts', 'ccc236f22d0f8943a4e26997868346cc208fcc2d', '06e4001ce1eff89350d9e82f61f3be4cb6d6ea59',
    '2b5ed4f8ed58d8b3ce80104ddd4806da03e83dbe41d6d5cfefd843701cfb50c6', '14fa547ed238bd0dfd8d2b0616d8a9457a06c0b6b171caaa0cc5fefd1d528918',
    'Read every child store row for one session, so a duplicate cannot mask another directory row.'],
  ['A', 'packages/ui/src/sync/transport-ready.ts', null, 'b041096401e9328f7c474ca6f156d4ac179e97f3',
    null, '252bc599588a40bd533e6c15e8216dfdd5d25896d229271d80935af9883527f2',
    'The event pipeline transport-readiness signal: reconnect or transport switch, no data.'],
];
const expected = {
  schemaVersion: 1, pullRequest: 549, issue: 'smarty-code#1378',
  baseHead: '11796181f2f7341730e3a467b347bdd0470b0642', sourceTreePath: 'packages/ui',
  sourceTree: 'a1747651dedb500b91fe912fe81a32ff1a142351', objectFormat: 'sha1',
  predecessorLedgerSha256: '976e08cc78ac5585b68ffc51e79b59d7d66b2e3b2eafd12286c5540851cde78b',
  predecessorLedgerBytesSha256: '25d8427aca66ccd894d0ce1a62467b0d79b37033b4fd3f9fd9db6a31b1283fc1',
  scope: inventory.map(([status, path]) => ({ status, path })),
  files: inventory.map(([status, path, predecessorBlob, blob, predecessorSha256, sha256, note]) => ({
    status, path, predecessorBlob, blob, predecessorMode: status === 'A' ? null : '100644', mode: '100644', predecessorSha256, sha256, note,
  })),
  note: 'Parent-native export of the #1378 repair and the smarty-code#1427 Send admission lane: 39 UI files, 22 modified and 17 added. sourceTree is the packages/ui Git subtree, excluding branding and scripts. Blob IDs and byte SHA256 are separate. Source inventory only; final native subtree binding, review, CI, full UI and same-Pi browser proof remain parent-owned gates.',
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

test('repair pins exact native subtree metadata, all 39 rows and independent current byte hashes', () => {
  const before = JSON.stringify(repair);
  assertInventory(repair);
  assert.equal(expected.files.length, 39);
  assert.equal(expected.files.filter(entry => entry.status === 'M').length, 22);
  assert.equal(expected.files.filter(entry => entry.status === 'A').length, 17);
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
