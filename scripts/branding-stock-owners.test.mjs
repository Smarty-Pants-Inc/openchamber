import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import './branding-managed-catalog.test.mjs';
import { responsePolicyOutputSha256 as currentOutput } from './branding-response-policy.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file).toString());
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const overlay = json('branding/behavior-overlay.json');
const overlays = new Map(overlay.files.map(entry => [entry.path, entry]));
const attributionPaths = [
  ...['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'uk', 'zh-CN', 'zh-TW']
    .map(locale => `packages/ui/src/lib/i18n/messages/${locale}.ts`),
  'packages/ui/src/sync/session-ui-store.ts',
];

test('PR486 status-read provenance binds exactly six source records and retains the tray baseline', () => {
  assert.deepEqual(overlay.sessionStatusReadProvenance, {
    pullRequest: 486,
    sourceHead: 'f1a339a16dd4199c38cb033a607491a55cb1c6c7',
    sourceEvidence: 'Parent Git-bound source head; independent 141-test source audit passed. No installed acceptance claim.',
  });
  const expected = [
    ['packages/ui/src/hooks/useTraySync.ts', '0d58cb36fb99d305a2ca022f86c3bbe9596a717aaff962b39d4ca351d62e6d9d'],
    ['packages/ui/src/sync/bootstrap.ts', '90d299061fa5ecbbd66499bf666c6cfd4dc8fc5a30306c0981977156c6a32f49'],
    ['packages/ui/src/sync/global-session-status.ts', '44c906039245017bcce56ce8741676476028be39fcdf43ba97c87f32d40840df'],
    ['packages/ui/src/sync/sync-context.tsx', '54b00b81133c34e43583881dc185a6459dfa98e24e126ae2d2784185707b7fd6'],
    ['packages/ui/src/sync/session-status-read.ts', '638f4fc06a163642522e25881370437c8bf7e34b6bfa1d2d2582efd395c819a1'],
    ['packages/ui/src/sync/sync-context-status-provenance.test.ts', 'ad42269dc7e1f9c1f03bb34f0ae874d04c01d86545fead4a31cc8a7fb063fa36'],
  ];
  assert.deepEqual(overlay.files.filter(entry => entry.sessionStatusReadSha256).map(entry => entry.path),
    expected.map(([file]) => file));
  assert.deepEqual(overlay.files.filter(entry => entry.sessionStatusReadAdded).map(entry => entry.path),
    expected.slice(1).map(([file]) => file));
  const coverage = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry]));
  for (const [file, hash] of expected) {
    const entry = overlays.get(file);
    assert.equal(entry.sessionStatusReadSha256, hash, file);
    assert.equal(entry.combinedSha256, hash, file);
    assert.equal(sha256(read(file)), hash, file);
    if (entry.sessionStatusReadAdded) {
      assert.equal(coverage.has(file), false, file);
      assert.equal(entry.brandingSha256, undefined, file);
      assert.equal(entry.preSessionStatusReadCombinedSha256, undefined, file);
      assert.equal(entry.behaviorSha256, hash, file);
    }
  }
  const tray = overlays.get(expected[0][0]);
  assert.equal(tray.preSessionStatusReadCombinedSha256,
    '08a0dfda3bd9e0eb08ad9a5a9c05cb93e05fb7273c1d9d8f0240bab628aa9f26');
  assert.equal(tray.preSessionStatusReadCombinedSha256, tray.managedCatalogSha256);
  assert.ok(tray.sessionStatusReadNote);
});

test('behavior overlay is explicit and preserves the original branding ledger', () => {
  assert.equal(overlay.brandingSource, '961cabb1e08b7c20ae7cd17cd8788ce8af0d469a');
  assert.equal(overlay.behaviorSource, '1ab7ae3799ee4e633785451ef28cf52f49e53797');
  assert.equal(overlays.size, overlay.files.length);
  assert.deepEqual([...overlays.keys()].sort(), [
    '.github/workflows/oc-review.yml', 'package.json',
    '.github/workflows/docs-source.yml', '.github/workflows/build-macos-arm64-dmg.yml',
    '.github/workflows/mobile-ci.yml', '.github/workflows/mobile-release.yml',
    '.github/workflows/release-desktop-smoke.yml', '.github/workflows/release.yml',
    'packages/ui/src/components/auth/SessionAuthGate.tsx',
    'packages/ui/src/components/auth/SessionAuthGate.behavior.test.tsx',
    'packages/ui/src/components/chat/ChatMessage.tsx',
    'packages/ui/src/sync/session-actions.test.ts', 'packages/web/package.json', 'packages/web/server/index.js',
    'packages/web/server/lib/notifications/apns-runtime.js',
    'packages/web/server/lib/opencode/core-routes.js',
    'packages/web/server/lib/opencode/core-routes.test.js',
    'packages/web/server/lib/opencode/proxy.js', 'packages/web/server/lib/opencode/routes.js', 'packages/web/src/api/settings.ts',
    'packages/web/server/lib/opencode/static-routes-runtime.js',
    ...attributionPaths,
    ...overlay.files.filter(entry => entry.managedCatalogAdded).map(entry => entry.path),
    ...overlay.files.filter(entry => entry.testDeterminismAdded).map(entry => entry.path),
    ...overlay.files.filter(entry => entry.originGuardAdded).map(entry => entry.path),
    ...overlay.files.filter(entry => entry.systemNoteAdded).map(entry => entry.path),
    ...overlay.files.filter(entry => entry.worktreeRootAdded).map(entry => entry.path),
    ...overlay.files.filter(entry => entry.sessionStatusReadAdded).map(entry => entry.path),
  ].sort());
  const original = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry]));
  for (const entry of overlay.files) {
    assert.ok(entry.reason, entry.path);
    assert.equal(entry.brandingSha256, original.get(entry.path)?.outputSha256, entry.path);
    assert.match(entry.behaviorSha256, /^[a-f0-9]{64}$/, entry.path);
    assert.equal(sha256(read(entry.path)), currentOutput(entry.path, entry.combinedSha256), entry.path);
  }
});

test('attribution overlay binds only its exact reviewed source without replacing donor evidence', () => {
  assert.equal(overlay.attributionSource, '3c71ed6017b1f30ba9bbb6be1ab259a98075279b');
  for (const file of attributionPaths) {
    const entry = overlays.get(file);
    assert.equal(entry.behaviorSource, overlay.attributionSource, file);
    assert.equal(entry.inboxStepsSha256 ?? entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, entry.combinedSha256, file);
  }
  const original = attributionPaths.map(file => {
    const entry = overlays.get(file);
    return [entry.path, entry.brandingSha256, entry.behaviorSha256, entry.behaviorSource];
  });
  assert.equal(sha256(JSON.stringify(original)), '7723f2af9ddbc50ba70b65b627bd9f6ef6114488525e2f8ad521beefa70d68c5');
});

test('native creation overlay binds its exact source and only the twelve attribution overlaps', () => {
  assert.equal(overlay.nativeCreationSource, '49db04d3938126afe57689dfbd224abf6e3c1328');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeCreationSha256).map(entry => entry.path), attributionPaths);
  for (const file of attributionPaths) {
    const entry = overlays.get(file);
    assert.match(entry.nativeCreationSha256, /^[a-f0-9]{64}$/, file);
    assert.equal(entry.inboxStepsSha256 ?? entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, sha256(read(file)), file);
  }
  const original = attributionPaths.map(file => [file, overlays.get(file).nativeCreationSha256]);
  assert.equal(sha256(JSON.stringify(original)), '3134c3a04a369259adc2504b65f7c8a4300a5a9f9fcc60a04392765a60c5da41');
});

test('foundation copy binds only the eleven locale outputs and preserves earlier evidence', () => {
  assert.equal(overlay.foundationCopySource, 'c3aed8611654fb61616d83573ee6c6a7fcd34514');
  const locales = attributionPaths.filter(file => file.includes('/i18n/messages/'));
  assert.deepEqual(overlay.files.filter(entry => entry.foundationCopySha256).map(entry => entry.path), locales);
  for (const file of locales) {
    const entry = overlays.get(file);
    assert.equal(entry.inboxStepsSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.foundationCopySha256, sha256(read(file)), file);
    assert.notEqual(entry.foundationCopySha256, entry.nativeCreationSha256, file);
  }
});

test('the inbox Steps locale layer binds its exact source over Status unavailable (smarty-code#1119)', () => {
  assert.equal(overlay.inboxStepsSource, 'f2a293d2eb5f4570fcad5088ce39065ae1e59271');
  const locales = attributionPaths.filter(file => file.includes('/i18n/messages/'));
  assert.deepEqual(overlay.files.filter(entry => 'inboxStepsSha256' in entry).map(entry => entry.path), locales);
  for (const file of locales) {
    const entry = overlays.get(file);
    assert.equal(entry.preInboxStepsCombinedSha256, entry.statusUnavailableSha256, file);
    assert.match(entry.inboxStepsSha256, /^[a-f0-9]{64}$/, file);
    assert.notEqual(entry.inboxStepsSha256, entry.preInboxStepsCombinedSha256, file);
    assert.equal(entry.inboxStepsSha256, entry.combinedSha256, file);
    assert.equal(sha256(read(file)), entry.inboxStepsSha256, file);
    assert.equal(entry.inboxStepsNote, 'smarty-code#1119: import and spread of inbox-steps.i18n.ts for inbox-backed Steps; all previous dictionary text retained.', file);
  }
});

test('native draft lifecycle overlay preserves prior source evidence and extends only the existing store overlap', () => {
  assert.equal(overlay.nativeLifecycleSource, '24170f63647a3acc20a819ef5139d300713157c0');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifecycleSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeLifecycleSha256, 'ad4850a64d50b0ce06107888171ed01a36fee3a69758e4c3153e787249e5d0fe');
  assert.equal(entry.nativeCreationSha256, '32dcfc9c63468cb32be5d92612455bbc7cf076e82ee626c9f34dc0ee5c258305');
});

test('native completion overlay binds its exact source without replacing earlier lifecycle evidence', () => {
  assert.equal(overlay.nativeCompletionSource, '17c5ce2b8ed0d5331d5b46a3337bb75a3474ce67');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeCompletionSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeCompletionSha256, '8c06820d14b78e8028c8e5c8f49d5eac6d9f643e9a845e9ff21c60956f95c807');
});

test('native input lifetime overlay preserves earlier completion evidence', () => {
  assert.equal(overlay.nativeLifetimeSource, 'd5f1a8964eafd6bafddd26dbe80318ae44040ec1');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifetimeSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeLifetimeSha256, '460d09e8b48454153c32b29707bcd440623ea8776d93ba46ecfa47da465517df');
});

test('ordinary selection binds the reviewed store successor without replacing earlier evidence', () => {
  assert.equal(overlay.ordinarySelectionSource, 'abfdf54c266428181e293bc28ee437c9f55de3a5');
  const file = 'packages/ui/src/sync/session-ui-store.ts';
  assert.deepEqual(overlay.files.filter(entry => entry.ordinarySelectionSha256).map(entry => entry.path), [file]);
  const entry = overlays.get(file);
  assert.equal(entry.ordinarySelectionSha256, 'bf78cd5db2b20b09ebbb95bbfb71227b4d00c86e61f32e6d8f948d0f05b21ac8');
  assert.equal(entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256, entry.combinedSha256);
  assert.equal(entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256, sha256(read(file)));
});

test('runtime recovery binds only the reviewed auth gate donor overlap', () => {
  const source = '3a3200ddae1611a079a76601ceba2b7ca1e43840';
  const file = 'packages/ui/src/components/auth/SessionAuthGate.tsx';
  assert.equal(overlay.runtimeRecoverySource, source);
  assert.deepEqual(overlay.files.filter(entry => entry.behaviorSource === source).map(entry => entry.path), [file]);
  const entry = overlays.get(file);
  assert.equal(entry.brandingSha256, '34f679f305ff987129350fafa279078411924b8f51b925474fedcfa9f48ed586');
  assert.equal(entry.behaviorSha256, '9ea67125fd0167f5322d775fe2a574ad345518be8a5fa1838491f4a85062cc1b');
  assert.equal(entry.preHumanAuthCombinedSha256, entry.behaviorSha256);
  assert.equal(entry.combinedSha256, entry.humanAuthSha256);
  // Later successor ledgers (Node member read-only, smarty-code#1442) bind the current output.
  assert.equal(sha256(read(file)), currentOutput(file, entry.humanAuthSha256));
});

test('human auth successor retains both earlier overlapping behavior hashes', () => {
  assert.equal(overlay.humanAuthSource, '578c060a38000455a3116417c30e7fe77b45007c');
  assert.deepEqual(overlay.files.filter(entry => entry.humanAuthSha256).map(entry => entry.path), [
    'packages/web/server/index.js', 'packages/ui/src/components/auth/SessionAuthGate.tsx',
  ]);
  const index = overlays.get('packages/web/server/index.js');
  assert.equal(index.behaviorSha256, 'c08c6d6c59e65d971f0f5e2d237049526ee97413073b864f0ef3b88f80180327');
  assert.equal(index.preHumanAuthCombinedSha256, '28f20d399e345e949f2a33ff2317faf73028f259676abcd3c873bbce207cc43c');
  for (const entry of overlay.files.filter(entry => entry.humanAuthSha256)) {
    assert.equal(entry.humanHostBoundarySha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.humanAuthSha256, entry.combinedSha256);
    assert.equal(sha256(read(entry.path)), currentOutput(entry.path, entry.humanHostBoundarySha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.humanAuthSha256));
  }
});

test('hosted UI proof preserves the preceding workflow evidence', () => {
  const entry = overlays.get('.github/workflows/oc-review.yml');
  assert.equal(entry.behaviorSource, '94dd8952fb23d3e2aac8a2533cccef5dde443960');
  assert.equal(entry.behaviorSha256, '1b9c75f1993b06158eaf78df7af03ac92812e7019e00ef0ee5a8cb854752b80f');
  assert.equal(entry.humanAuthUiProofSource, '0d0f988aa98c345bf2bfc79d0c9b4e753347d744');
  assert.equal(entry.humanAuthUiProofSha256, entry.preForgeRunnerCombinedSha256);
  assert.equal(entry.forgeRunnerSha256, entry.combinedSha256);
});

test('Forge workflows bind exact successor bytes without replacing coverage or prior workflow evidence', () => {
  assert.deepEqual(overlay.forgeRunnerProvenance, {
    reviewedHead: '7f2d8f550b160e7e74026a58dcd693d4befb3072',
    finding: 'openchamber#501 Astra round 2: own-source PR guard, workflow ownership, hosted jobs and Android jobs',
    predecessorLedgerSha256: '67dda5752d97d95c55e0415f2c91ceda67b13ccf36064bce2f4152aab4cd3ad2',
    predecessorLedgerBytesSha256: 'b9a267f250b259ec739f3b9de8bd414529917395a33ab924a46dbc99f49676f5',
    coverageSha256: '10838b01de0e37e7deb6085d7097bfa4699eb71fef0f96ef6d0e1cdf605722df',
  });
  assert.equal(sha256(read('branding/coverage.json')), overlay.forgeRunnerProvenance.coverageSha256);
  const expected = [
    ['.github/workflows/oc-review.yml', 'b1a9b7c0c4743c1af912dd1ca505b4c4e9c73bcc1ef41e985512f4a436c4c71a', '674da75627d8d6788f5048a9eb306e65e5c5a07235d090b4f44b7d387a714297'],
    ['.github/workflows/docs-source.yml', '238ae5b0f975f50b3993734d1c618dd4138d7eb5a58e729eb50d9788155be7bc', '238ae5b0f975f50b3993734d1c618dd4138d7eb5a58e729eb50d9788155be7bc'],
    ['.github/workflows/build-macos-arm64-dmg.yml', '282ed681fea6df1cdebea58a80b2a2f086055af0559b77483f0ab43d7ce35357', '973cf458a73a5d0d5486b15afb84e64e12c8e4038a8939091278e4151e8bcfa4'],
    ['.github/workflows/mobile-ci.yml', '915c779672e7d1208049f607edd7a6272798b31b4390a2cffba1b876753763b5', 'ba7b58fbd604d6b23c1ad0474e802e42dd6772c937f9bef3eebbf6fc9a074131'],
    ['.github/workflows/mobile-release.yml', 'ff1ba81f5588f0f4e7aed3448be052c73843f432e16bd97124594b03a5a93e8b', '684191a77a185b1c773450dae25e0230343fb4af7f5977cb4d170b475eaa45f5'],
    ['.github/workflows/release-desktop-smoke.yml', 'cf01032cba6a3c98ad164aba2aebfc593703bf084fd411f61691458cf654284f', '716438d63a512dc337715d92b9985dc0e813ee53e5c5fa290c1943539bfcff41'],
    ['.github/workflows/release.yml', '01ce42451b6202d0f387d1d5e5fc932d81f106ff511cfe2c28d6640477f5f1b5', 'a886626e2e1ac33993953e50a880b61c191f4fed8f23e582d89d1c1d5776cf44'],
  ];
  assert.deepEqual(overlay.files.filter(entry => entry.forgeRunnerSha256).map(entry => entry.path), expected.map(([file]) => file));
  assert.deepEqual(overlay.files.filter(entry => entry.forgeRunnerAdded).map(entry => entry.path), expected.slice(1).map(([file]) => file));
  for (const [file, baseHash, outputHash] of expected) {
    const entry = overlays.get(file);
    assert.equal(entry.forgeRunnerBaseSha256, baseHash, file);
    assert.equal(entry.forgeRunnerSha256, outputHash, file);
    assert.equal(entry.combinedSha256, outputHash, file);
    assert.equal(sha256(read(file)), outputHash, file);
    if (entry.forgeRunnerAdded) {
      assert.equal(entry.behaviorSource, overlay.forgeRunnerProvenance.reviewedHead, file);
      assert.equal(entry.behaviorSha256, baseHash, file);
    }
  }
  const review = overlays.get('.github/workflows/oc-review.yml');
  assert.equal(review.preForgeRunnerCombinedSha256, '14526c052328cedc9a6e68c3b96c158a2c5f8f4dc12597396ba7891e0b0d69eb');
  assert.equal(overlays.get('.github/workflows/docs-source.yml').brandingSha256, 'c1b0e3beec920ef2d0e043112d020e04b3831717074623310fe533d88bab5f86');
});

test('static cache overlay binds the exact owning repair without replacing branding evidence', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/static-routes-runtime.js');
  assert.equal(entry.behaviorSource, '1d523f4766b6fd75a1298a0159599d35f3483e73');
  assert.equal(entry.behaviorSha256, entry.combinedSha256);
});

test('stock owners retain behavior except explicitly reviewed overlay and owned labels', () => {
  const parity = json('branding/stock-owner-parity.json');
  assert.equal(parity.stock, '2dfd1190eba8853c766c29ae27f09aeacc86bdb9');
  for (const { path: file, normalize, stockSha256 } of parity.files) {
    let source = read(file).toString();
    if (normalize.length) {
      assert.equal(source.split(normalize[0]).length - 1, 1, file);
      source = source.replace(normalize[0], normalize[1]);
    }
    const changed = overlays.get(file);
    if (changed) {
      assert.equal(normalize.length, 0, file);
      assert.equal(changed.inboxStepsSha256 ?? changed.statusUnavailableSha256 ?? changed.inboxStreamSha256 ?? changed.fleetListSha256 ?? changed.herdrListSha256 ?? changed.catalogReloadSha256 ?? changed.sessionVoiceSha256 ?? changed.persistedTargetSha256 ?? changed.restorationSha256 ?? changed.coldDraftSha256 ?? changed.managedDraftSha256 ?? changed.catalogFixtureSha256 ?? changed.managedCatalogSha256 ?? changed.humanAuthUiProofSha256 ?? changed.humanAuthSha256 ?? changed.ordinarySelectionSha256 ?? changed.foundationCopySha256 ?? changed.nativeLifetimeSha256 ?? changed.nativeCompletionSha256 ?? changed.nativeLifecycleSha256 ?? changed.nativeCreationSha256 ?? changed.behaviorSha256, changed.combinedSha256, file);
      assert.equal(changed.brandingSha256, stockSha256, file);
    }
    assert.equal(sha256(source), changed?.combinedSha256 ?? stockSha256, file);
  }
  assert.equal(existsSync(path.join(root, 'packages/vscode/src/bridge-session-runtime.ts')), false);
  assert.equal(existsSync(path.join(root, 'packages/vscode/src/bridge-session-runtime.test.ts')), false);
});

test('every donor file/hunk has a disposition and the reviewed output has not drifted', () => {
  const coverage = json('branding/coverage.json');
  assert.equal(coverage.distinctDonorFiles, 770);
  assert.equal(coverage.files.length, 770);
  assert.deepEqual(coverage.brandedDonorFilesOutsideBothMerges, []);
  assert.equal(new Set(coverage.files.map(({ path }) => path)).size, 770);
  for (const entry of coverage.files) {
    assert.ok(entry.note, entry.path);
    assert.ok(entry.disposition, entry.path);
    assert.ok(entry.sources.length, entry.path);
    for (const source of entry.sources) {
      assert.ok(source.patchSha256, entry.path);
      for (const hunk of source.hunks) assert.ok(hunk.resolution, `${entry.path}: ${hunk.header}`);
    }
    const exists = existsSync(path.join(root, entry.path));
    assert.equal(exists ? sha256(read(entry.path)) : null,
      currentOutput(entry.path, overlays.get(entry.path)?.combinedSha256 ?? entry.outputSha256), entry.path);
  }
});

test('the session-list allowlist layer binds its exact commit over the reviewed proxy behavior (smarty-code#126 F4)', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/proxy.js');
  assert.equal(overlay.herdrListSource, 'b6d4f1b5a3dd67c222b75ed87ec04e3415c81f38');
  assert.equal(entry.preHerdrListCombinedSha256, entry.behaviorSha256);
  assert.equal(entry.herdrListSha256, entry.preFleetListCombinedSha256); // The next layer (#863/#870) starts from it.
  assert.ok(entry.herdrListNote);
  assert.deepEqual(overlay.files.filter(file => file.herdrListSha256).map(file => file.path), ['packages/web/server/lib/opencode/proxy.js']);
});

test('the fleet session-list layer binds its exact commit over the Herdr list layer (smarty-code#863, #870)', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/proxy.js');
  assert.equal(overlay.fleetListSource, '47eb1c68d3f64129018078eed1e218cb23baff50');
  assert.equal(entry.preFleetListCombinedSha256, entry.herdrListSha256);
  assert.equal(entry.fleetListSha256, entry.preInboxStreamCombinedSha256); // The next layer (#701) starts from it.
  assert.ok(entry.fleetListNote);
  assert.deepEqual(overlay.files.filter(file => file.fleetListSha256).map(file => file.path), ['packages/web/server/lib/opencode/proxy.js']);
});

test('the inbox stream layer binds its exact commit over the fleet session-list layer (smarty-code#701)', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/proxy.js');
  assert.equal(overlay.inboxStreamSource, 'd16efdf6a265496d06a68e8f76a7721905d0bab1');
  assert.equal(entry.preInboxStreamCombinedSha256, entry.fleetListSha256);
  assert.equal(entry.inboxStreamSha256, entry.preCodeMadeListCombinedSha256); // The next layer (#957) starts from it.
  assert.ok(entry.inboxStreamNote);
  assert.deepEqual(overlay.files.filter(file => file.inboxStreamSha256).map(file => file.path), ['packages/web/server/lib/opencode/proxy.js']);
});

test('the Code-made session-list layer binds its exact commit over the inbox stream layer (smarty-code#957)', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/proxy.js');
  assert.equal(overlay.codeMadeListSource, 'ebf56e66943ee912b727dab8ebb0e336d50f733d');
  assert.equal(entry.preCodeMadeListCombinedSha256, entry.inboxStreamSha256);
  assert.equal(entry.codeMadeListSha256, entry.preProxyConnectionCombinedSha256);
  assert.ok(entry.codeMadeListNote);
  assert.deepEqual(overlay.files.filter(file => file.codeMadeListSha256).map(file => file.path), ['packages/web/server/lib/opencode/proxy.js']);
});

test('the proxy Connection layer binds its exact source and successor over the Code-made list layer (openchamber#491)', () => {
  const file = 'packages/web/server/lib/opencode/proxy.js';
  const entry = overlays.get(file);
  assert.equal(overlay.proxyConnectionSource, 'e9f6fdc38ffbadf43113d1b8202489332f6fe95f');
  assert.deepEqual(overlay.files.filter(candidate => 'proxyConnectionSha256' in candidate).map(candidate => candidate.path), [file]);
  assert.equal(entry.preProxyConnectionCombinedSha256, 'a858ec4a5b4a81ef272d3b5d2a4e73882db8c45a9e7a29809341e0d12dd62b68');
  assert.equal(entry.preProxyConnectionCombinedSha256, entry.codeMadeListSha256);
  assert.equal(entry.proxyConnectionSha256, '6d957a7569b2bfc30b7d27d8fdf50cae442de80abf7e6ed7f0530d3a79653172');
  assert.equal(entry.proxyConnectionSha256, entry.combinedSha256);
  assert.equal(sha256(read(file)), entry.proxyConnectionSha256);
  assert.ok(entry.proxyConnectionNote);
});

test('the model-prefs unload flush binds its exact fix commit over the settings client only (smarty-code#126 F6)', () => {
  assert.match(overlay.modelPrefsUnloadSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.modelPrefsUnloadSha256).map(file => file.path), ['packages/web/src/api/settings.ts']);
  const entry = overlays.get('packages/web/src/api/settings.ts');
  assert.equal(entry.modelPrefsUnloadSha256, entry.combinedSha256);
  assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  assert.match(entry.preModelPrefsUnloadCombinedSha256, /^[a-f0-9]{64}$/);
});

test('the unsaved label binds its exact fix commit over the message row only (slice 1 L1)', () => {
  assert.match(overlay.unsavedLabelSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.unsavedLabelSha256).map(file => file.path), ['packages/ui/src/components/chat/ChatMessage.tsx']);
  const entry = overlays.get('packages/ui/src/components/chat/ChatMessage.tsx');
  assert.equal(entry.unsavedLabelSha256, entry.preDesign538CombinedSha256); // #538 layers the sender row over it.
  assert.equal(entry.preUnsavedLabelCombinedSha256, 'dfc540f2a7799fe707065b44ef9eabf8bf6668f34988499c08615bc4cb884ab8'); // The Stop-wording layer it replaces.
});

test('the context window binds its exact fix commit over the header only (smarty-dev#777 G14)', () => {
  assert.match(overlay.contextWindowSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.contextWindowSha256).map(file => file.path), ['packages/ui/src/components/layout/Header.tsx']);
  const entry = overlays.get('packages/ui/src/components/layout/Header.tsx');
  assert.equal(entry.contextWindowSha256, entry.preDesign538CombinedSha256); // #538 layers the account menu over it.
  assert.equal(entry.preContextWindowCombinedSha256, '5fd0340114593d973dcaef295f78b0f647207f35bdc6b3a0afdb3b81639309d4');
});

test('deterministic stall tests bind their exact commit as new overlay entries', () => {
  assert.match(overlay.testDeterminismSource, /^[a-f0-9]{40}$/);
  const added = overlay.files.filter(entry => entry.testDeterminismAdded);
  assert.deepEqual(added.map(entry => entry.path).sort(), ['packages/web/server/lib/event-stream/runtime.test.js', 'packages/web/server/opencode-proxy.test.js']);
  for (const entry of added) {
    assert.equal(entry.testDeterminismSha256, entry.combinedSha256);
    assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  }
});

test('the passwordless origin guard binds its exact commit over the message-stream runtime only (smarty-code#391)', () => {
  assert.match(overlay.originGuardSource, /^[a-f0-9]{40}$/);
  const added = overlay.files.filter(entry => entry.originGuardAdded);
  assert.deepEqual(added.map(entry => entry.path), ['packages/web/server/lib/event-stream/runtime.js']);
  const original = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry]));
  for (const entry of added) {
    assert.equal(entry.brandingSha256, original.get(entry.path).outputSha256); // The donor bytes it replaces.
    assert.equal(entry.originGuardSha256, entry.preHumanHostBoundaryCombinedSha256);
    assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  }
});

test('the first-send handoff binds its exact fix commit over the session store only (smarty-dev#856)', () => {
  assert.match(overlay.firstSendHandoffSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.firstSendHandoffSha256).map(file => file.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  // The waiting-open layer (smarty-code#608) sits on top: this layer's output is that layer's predecessor.
  assert.equal(entry.firstSendHandoffSha256, entry.preManagedHoldCombinedSha256);
  assert.equal(entry.preFirstSendHandoffCombinedSha256, '8caf10c8c849c4e133e07a3189d8bfdb58ece39c8c655b7d2f427a06f242bf0b');
});

test('the #538 layer binds its exact feature commit over the message row and the header only (smarty-code#538)', () => {
  assert.match(overlay.design538Source, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.design538Sha256).map(file => file.path).sort(),
    ['packages/ui/src/components/chat/ChatMessage.tsx', 'packages/ui/src/components/layout/Header.tsx']);
  for (const entry of overlay.files.filter(file => file.design538Sha256)) {
    // The #739 Fabric row (voiceFabric) is the layer above it on the message row.
    assert.equal(entry.design538Sha256, entry.preVoiceFabricCombinedSha256 ?? entry.combinedSha256);
    assert.equal(sha256(read(entry.path)), entry.combinedSha256);
    assert.ok(entry.design538Note);
  }
});

test('the creation-fields header binds its exact fix commit over the server entry only (smarty-code#523)', () => {
  assert.match(overlay.creationFieldsSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.creationFieldsSha256).map(file => file.path), ['packages/web/server/index.js']);
  const entry = overlays.get('packages/web/server/index.js');
  // The notification lookup's directory (smarty-code#536) is the layer above it now.
  assert.equal(entry.creationFieldsSha256, entry.preNotificationAuthCombinedSha256);
  assert.equal(entry.preCreationFieldsCombinedSha256, 'd2bd6fbd109195adb3b4cef906cf48db8033792f3e1fdbaec37ef22a6b1292dd');
});

test('the waiting open binds its exact commit over the session store only (smarty-code#608)', () => {
  assert.match(overlay.managedHoldSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.managedHoldSha256).map(file => file.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  // The send client ID layer (smarty-code#827) sits on top: this layer's output is that layer's predecessor.
  assert.equal(entry.managedHoldSha256, entry.preSendClientIdCombinedSha256);
  assert.equal(entry.preManagedHoldCombinedSha256, 'e9ef552f2295536c7b61236f09c1f5fc57e4f29238d0a56c737f6920b5e40445');
});

test('the send client ID binds its exact commit over the session store only (smarty-code#827, openchamber#375)', () => {
  assert.match(overlay.sendClientIdSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.sendClientIdSha256).map(file => file.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.sendClientIdSha256, entry.prePersonalSidebarCombinedSha256);
  assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  assert.equal(entry.preSendClientIdCombinedSha256, '4c2cef7df7ccefdf2bf3853d2941c8dc78f16a276c4030c31b1725be092c306c');
});

test('personal sidebar binds only the reviewed session-store successor', () => {
  assert.equal(overlay.personalSidebarSource, '9ba0596d2011b3339bb101160d82bf88155870ba');
  assert.deepEqual(overlay.files.filter(entry => entry.personalSidebarSha256).map(entry => entry.path),
    ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.prePersonalSidebarCombinedSha256, entry.sendClientIdSha256);
  assert.equal(entry.prePersonalSidebarCombinedSha256, '9b04f3a49521bd7e448fc90b7884e57c8653e8b720cc9f7f5719cc581bcee272');
  assert.equal(entry.personalSidebarSha256, '06a5508b6b65349af5672b6d5d7f416e92ab0b145b80032d21e600e1dfbb89de');
  assert.equal(entry.personalSidebarSha256, entry.prePersonalSidebarReviewCombinedSha256);
  assert.equal(sha256(read(entry.path)), entry.personalSidebarRevealSha256);
  assert.ok(entry.personalSidebarNote);
});

test('personal sidebar review correction binds the released store above original reviewed source', () => {
  assert.equal(overlay.personalSidebarReviewBase, overlay.personalSidebarSource);
  assert.equal(overlay.personalSidebarReviewFinding, 'openchamber#454 review 5914164668 finding 1');
  assert.deepEqual(overlay.files.filter(entry => 'personalSidebarReviewSha256' in entry).map(entry => entry.path),
    ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.prePersonalSidebarReviewCombinedSha256, entry.personalSidebarSha256);
  assert.match(entry.personalSidebarReviewSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(entry.personalSidebarReviewSha256, entry.personalSidebarSha256);
  assert.equal(entry.personalSidebarReviewSha256, '55c8ea1f9a25110b480346825bd4828e0607fbafea1c017c7a13209e34064240');
  assert.equal(entry.personalSidebarReviewSha256, entry.prePersonalSidebarRevealCombinedSha256);
  assert.equal(sha256(read(entry.path)), entry.personalSidebarRevealSha256);
  assert.ok(entry.personalSidebarReviewNote);
});

test('voice call notes: session assist binds its exact fix commit as a new overlay entry (system notes, smarty-code#360)', () => {
  assert.match(overlay.systemNoteSource, /^[a-f0-9]{40}$/);
  const added = overlay.files.filter(entry => entry.systemNoteAdded);
  assert.deepEqual(added.map(entry => entry.path), ['packages/web/server/lib/session-assist/runtime.js']);
  for (const entry of added) {
    assert.equal(entry.systemNoteSha256, entry.combinedSha256);
    assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  }
});

test('the notification lookup\'s session directory binds its exact fix commit over the server entry only (smarty-code#536)', () => {
  assert.match(overlay.notificationAuthSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.notificationAuthSha256).map(file => file.path), ['packages/web/server/index.js']);
  const entry = overlays.get('packages/web/server/index.js');
  assert.equal(entry.notificationAuthSha256, entry.preHumanHostBoundaryCombinedSha256);
  assert.equal(sha256(read(entry.path)), currentOutput(entry.path, entry.combinedSha256));
  assert.equal(entry.preNotificationAuthCombinedSha256, '3c6abbada66fec3ec219271354e220c42a55af97e7bef1602211e6832f5476c2');
});

test('the #739 Fabric message row binds its exact feature commit over the message row only (smarty-code#739)', () => {
  assert.match(overlay.voiceFabricSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.voiceFabricSha256).map(file => file.path), ['packages/ui/src/components/chat/ChatMessage.tsx']);
  const entry = overlays.get('packages/ui/src/components/chat/ChatMessage.tsx');
  assert.equal(entry.voiceFabricSha256, entry.combinedSha256);
  assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  assert.equal(entry.preVoiceFabricCombinedSha256, '5c9482283de9c85863d23f8682ac0e782b0efb7aaf7b53ba7a8a0b3225c27e95');
});

test('human Host boundary binds exactly two successors and preserves every historical field', () => {
  assert.equal(overlay.humanHostBoundarySource, '12463c2fb0e599623e631e772f1699e4e1669965');
  const expected = [
    ['packages/web/server/index.js',
      '606af7c4959281422177b123e4025e953ba7a3ddc2ec37c60de76584f9da66cd',
      '4782c23cdb7cb41af9fce49ea8eb8576edf64a77a574489509b70eee851532fe'],
    ['packages/web/server/lib/event-stream/runtime.js',
      '7882f79295c7731d650f13951fab7016cae21b5c08f75333dc56d33bafa2c099',
      '74c761d0a040bf4d995358de63ca8db5ad522f10721489bb3d7c41c26b609d67'],
  ];
  assert.deepEqual(overlay.files.filter(entry => entry.humanHostBoundarySha256).map(entry => entry.path),
    expected.map(([file]) => file));
  const historical = structuredClone(overlay);
  // Unwind PR486 first: it is the newest layer, above inbox Steps; the result is the exact smarty-code ledger.
  historical.files = historical.files.filter(entry => !entry.sessionStatusReadAdded);
  for (const entry of historical.files.filter(file => file.preSessionStatusReadCombinedSha256)) {
    assert.equal(entry.sessionStatusReadSha256, entry.combinedSha256);
    assert.equal(entry.preSessionStatusReadCombinedSha256, entry.managedCatalogSha256);
    entry.combinedSha256 = entry.preSessionStatusReadCombinedSha256;
    delete entry.preSessionStatusReadCombinedSha256;
    delete entry.sessionStatusReadSha256;
    delete entry.sessionStatusReadNote;
  }
  delete historical.sessionStatusReadProvenance;
  assert.equal(sha256(JSON.stringify(historical)),
    '6a636b11808d1e2b28ad0afc311e6592ebc838ab8194adaa809c0d693a04af10');
  assert.equal(sha256(`${JSON.stringify(historical, null, 2)}\n`), '42cb0bcc611bd57ca55b84ac94f08906385546ab7f8f39ccadc27dcb6bc4c8e5');
  // Unwind Steps to the exact upstream ledger, retaining Forge placement and provenance.
  assert.equal(historical.inboxStepsSource, 'f2a293d2eb5f4570fcad5088ce39065ae1e59271');
  delete historical.inboxStepsSource;
  const inboxSteps = historical.files.filter(entry => 'inboxStepsSha256' in entry);
  assert.deepEqual(inboxSteps.map(entry => entry.path), attributionPaths.filter(file => file.includes('/i18n/messages/')));
  for (const entry of inboxSteps) {
    assert.equal(entry.inboxStepsSha256, entry.combinedSha256);
    assert.equal(entry.preInboxStepsCombinedSha256, entry.statusUnavailableSha256);
    assert.ok(entry.inboxStepsNote);
    entry.combinedSha256 = entry.preInboxStepsCombinedSha256;
    delete entry.preInboxStepsCombinedSha256;
    delete entry.inboxStepsSha256;
    delete entry.inboxStepsNote;
  }
  assert.equal(sha256(JSON.stringify(historical)), '6db9d621c04a942e308030a4d7a7cf60d55af973bf8d5064659c1cab342aa2e3');
  assert.equal(sha256(`${JSON.stringify(historical, null, 2)}\n`), 'ded363c23fa52c512a26726c144ff50e0a8a8d2aecafacfc99a2e48d058ecb56');
  // Unwind Forge placement next; every older ledger assertion still runs below.
  assert.equal(historical.forgeRunnerProvenance.reviewedHead, '7f2d8f550b160e7e74026a58dcd693d4befb3072');
  delete historical.forgeRunnerProvenance;
  historical.files = historical.files.filter(entry => !entry.forgeRunnerAdded);
  const forgeWorkflow = historical.files.find(entry => entry.path === '.github/workflows/oc-review.yml');
  assert.equal(forgeWorkflow.preForgeRunnerCombinedSha256, forgeWorkflow.humanAuthUiProofSha256);
  assert.equal(forgeWorkflow.forgeRunnerSha256, forgeWorkflow.combinedSha256);
  forgeWorkflow.combinedSha256 = forgeWorkflow.preForgeRunnerCombinedSha256;
  delete forgeWorkflow.preForgeRunnerCombinedSha256;
  delete forgeWorkflow.forgeRunnerBaseSha256;
  delete forgeWorkflow.forgeRunnerSha256;
  assert.equal(sha256(JSON.stringify(historical)), '67dda5752d97d95c55e0415f2c91ceda67b13ccf36064bce2f4152aab4cd3ad2');
  assert.equal(sha256(`${JSON.stringify(historical, null, 2)}\n`), 'b9a267f250b259ec739f3b9de8bd414529917395a33ab924a46dbc99f49676f5');
  // Unwind the proxy Connection successor first, then run every earlier ledger assertion unchanged.
  assert.equal(historical.proxyConnectionSource, 'e9f6fdc38ffbadf43113d1b8202489332f6fe95f');
  delete historical.proxyConnectionSource;
  const proxyConnection = historical.files.filter(entry => 'proxyConnectionSha256' in entry);
  assert.deepEqual(proxyConnection.map(entry => entry.path), ['packages/web/server/lib/opencode/proxy.js']);
  for (const entry of proxyConnection) {
    assert.equal(entry.proxyConnectionSha256, '6d957a7569b2bfc30b7d27d8fdf50cae442de80abf7e6ed7f0530d3a79653172');
    assert.equal(entry.proxyConnectionSha256, entry.combinedSha256);
    assert.equal(entry.preProxyConnectionCombinedSha256, 'a858ec4a5b4a81ef272d3b5d2a4e73882db8c45a9e7a29809341e0d12dd62b68');
    assert.equal(entry.preProxyConnectionCombinedSha256, entry.codeMadeListSha256);
    assert.ok(entry.proxyConnectionNote);
    entry.combinedSha256 = entry.preProxyConnectionCombinedSha256;
    delete entry.preProxyConnectionCombinedSha256;
    delete entry.proxyConnectionSha256;
    delete entry.proxyConnectionNote;
  }
  assert.equal(sha256(JSON.stringify(historical)), '2513793752310488e83c73a53feb82d7c460dee9c95d70db10e3b7220d29f9b9');
  assert.equal(sha256(`${JSON.stringify(historical, null, 2)}\n`), '72239c6062dcc912d129a727209d7c92c926532b465469c363a1f49b3cfab822');

  assert.deepEqual(historical.personalSidebarRevealProvenance, {
    reviewedHead: 'a536a54446b8009d3b85a617e6f67d8434d5de96',
    finding: "openchamber#454 security comment 5919567288 P2 - Failed owner admission leaves A's pending reveal able to write B's preferences",
    predecessorLedgerSha256: '05d8f3cad425c23bb31213a20db92b20e082474c6b7c312bf13a69d40b9b40e7',
    predecessorLedgerBytesSha256: '98dd971ce744a0dfa0570c41a644f4b8a92d2ed4718b2357a47d5f06f4ad9c7d',
  });
  delete historical.personalSidebarRevealProvenance;
  const revealCorrection = historical.files.filter(entry => 'personalSidebarRevealSha256' in entry);
  assert.deepEqual(revealCorrection.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of revealCorrection) {
    assert.match(entry.personalSidebarRevealSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.personalSidebarRevealSha256, entry.combinedSha256);
    assert.notEqual(entry.personalSidebarRevealSha256, entry.prePersonalSidebarRevealCombinedSha256);
    assert.equal(entry.prePersonalSidebarRevealCombinedSha256, entry.personalSidebarReviewSha256);
    assert.equal(entry.prePersonalSidebarRevealCombinedSha256, '55c8ea1f9a25110b480346825bd4828e0607fbafea1c017c7a13209e34064240');
    assert.ok(entry.personalSidebarRevealNote);
    entry.combinedSha256 = entry.prePersonalSidebarRevealCombinedSha256;
    delete entry.prePersonalSidebarRevealCombinedSha256;
    delete entry.personalSidebarRevealSha256;
    delete entry.personalSidebarRevealNote;
  }
  assert.equal(historical.files.length, 37);
  assert.equal(sha256(JSON.stringify(historical)), '05d8f3cad425c23bb31213a20db92b20e082474c6b7c312bf13a69d40b9b40e7');
  assert.equal(sha256(`${JSON.stringify(historical, null, 2)}\n`), '98dd971ce744a0dfa0570c41a644f4b8a92d2ed4718b2357a47d5f06f4ad9c7d');
  assert.equal(historical.personalSidebarReviewBase, historical.personalSidebarSource);
  assert.equal(historical.personalSidebarReviewFinding, 'openchamber#454 review 5914164668 finding 1');
  delete historical.personalSidebarReviewBase;
  delete historical.personalSidebarReviewFinding;
  const reviewCorrection = historical.files.filter(entry => 'personalSidebarReviewSha256' in entry);
  assert.deepEqual(reviewCorrection.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of reviewCorrection) {
    assert.match(entry.personalSidebarReviewSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.personalSidebarReviewSha256, entry.combinedSha256);
    assert.equal(entry.prePersonalSidebarReviewCombinedSha256, entry.personalSidebarSha256);
    assert.ok(entry.personalSidebarReviewNote);
    entry.combinedSha256 = entry.prePersonalSidebarReviewCombinedSha256;
    delete entry.prePersonalSidebarReviewCombinedSha256;
    delete entry.personalSidebarReviewSha256;
    delete entry.personalSidebarReviewNote;
  }
  assert.equal(historical.personalSidebarSource, '9ba0596d2011b3339bb101160d82bf88155870ba');
  delete historical.personalSidebarSource;
  const personalSidebar = historical.files.filter(entry => entry.personalSidebarSha256);
  assert.deepEqual(personalSidebar.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of personalSidebar) {
    assert.equal(entry.personalSidebarSha256, entry.combinedSha256);
    assert.equal(entry.personalSidebarSha256, '06a5508b6b65349af5672b6d5d7f416e92ab0b145b80032d21e600e1dfbb89de');
    assert.equal(entry.prePersonalSidebarCombinedSha256, entry.sendClientIdSha256);
    assert.ok(entry.personalSidebarNote);
    entry.combinedSha256 = entry.prePersonalSidebarCombinedSha256;
    delete entry.prePersonalSidebarCombinedSha256;
    delete entry.personalSidebarSha256;
    delete entry.personalSidebarNote;
  }
  delete historical.humanHostBoundarySource;
  delete historical.humanSessionLifetimeProvenance;
  for (const entry of historical.files.filter(file => file.preHumanSessionLifetimeCombinedSha256)) {
    entry.combinedSha256 = entry.preHumanSessionLifetimeCombinedSha256;
    delete entry.preHumanSessionLifetimeCombinedSha256;
    delete entry.humanSessionLifetimeSha256;
    delete entry.humanSessionLifetimeNote;
  }
  for (const [file, predecessor, successor] of expected) {
    const entry = overlays.get(file);
    assert.equal(entry.preHumanHostBoundaryCombinedSha256, predecessor, file);
    assert.equal(entry.humanHostBoundarySha256, successor, file);
    assert.equal(entry.combinedSha256, entry.humanSessionLifetimeSha256 ?? successor, file);
    assert.equal(sha256(read(file)), currentOutput(file, entry.humanSessionLifetimeSha256 ?? successor), file);
    assert.ok(entry.humanHostBoundaryNote, file);
    const original = historical.files.find(candidate => candidate.path === file);
    original.combinedSha256 = predecessor;
    delete original.preHumanHostBoundaryCombinedSha256;
    delete original.humanHostBoundarySha256;
    delete original.humanHostBoundaryNote;
  }
  assert.equal(sha256(JSON.stringify(historical)),
    '2d82cc4319d8f8ebe9488652c820f0612b2a016c944b70d012ce2d64bc48aa24');
});

test('human session lifetime binds the named finding and exact event successor bytes', () => {
  assert.deepEqual(overlay.humanSessionLifetimeProvenance, {
    reviewedHead: '12463c2fb0e599623e631e772f1699e4e1669965',
    finding: 'P2 - Event-stream and dictation WebSockets retain authorization after the human session ends',
  });
  const file = 'packages/web/server/lib/event-stream/runtime.js';
  assert.deepEqual(overlay.files.filter(entry => entry.preHumanSessionLifetimeCombinedSha256)
    .map(entry => entry.path), [file]);
  const entry = overlays.get(file);
  assert.equal(entry.preHumanSessionLifetimeCombinedSha256,
    '74c761d0a040bf4d995358de63ca8db5ad522f10721489bb3d7c41c26b609d67');
  assert.equal(entry.preHumanSessionLifetimeCombinedSha256, entry.humanHostBoundarySha256);
  assert.match(entry.humanSessionLifetimeSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(entry.humanSessionLifetimeSha256, entry.preHumanSessionLifetimeCombinedSha256);
  assert.equal(entry.humanSessionLifetimeSha256, entry.combinedSha256);
  assert.equal(sha256(read(file)), entry.humanSessionLifetimeSha256);
  assert.ok(entry.humanSessionLifetimeNote);
});

test('the shared worktree root binds its exact fix commit as a new overlay entry over the git service only (smarty-code#629)', () => {
  assert.match(overlay.worktreeRootSource, /^[a-f0-9]{40}$/);
  const added = overlay.files.filter(entry => entry.worktreeRootAdded);
  assert.deepEqual(added.map(entry => entry.path), ['packages/web/server/lib/git/service.js']);
  for (const entry of added) {
    assert.equal(entry.worktreeRootSha256, entry.combinedSha256);
    // Later successor ledgers (Node member execution, smarty-code#1356) bind the current output.
    assert.equal(sha256(read(entry.path)), currentOutput(entry.path, entry.combinedSha256));
  }
});
