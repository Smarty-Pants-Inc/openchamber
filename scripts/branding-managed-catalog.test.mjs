import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { responsePolicyOutputSha256 as currentOutput } from './branding-response-policy.mjs';

const overlay = JSON.parse(readFileSync(new URL('../branding/behavior-overlay.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const consumers = [
  'packages/ui/src/components/layout/Header.tsx',
  'packages/ui/src/components/mini-chat/MiniChatLayout.tsx',
  'packages/ui/src/hooks/useMenuActions.ts',
  'packages/ui/src/hooks/useTraySync.ts',
  'packages/ui/src/hooks/useWindowTitle.ts',
];
const paths = [...consumers,
  ...['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'uk', 'zh-CN', 'zh-TW']
    .map(locale => `packages/ui/src/lib/i18n/messages/${locale}.ts`),
  'packages/ui/src/sync/session-ui-store.ts', 'packages/web/server/index.js',
];

test('managed catalog binds eighteen exact overlaps and retains the full historical ledger', () => {
  assert.equal(overlay.managedCatalogSource, '1273ddf4b2bcbf278675e9dbd0024eb0d5a784cc');
  assert.deepEqual(overlay.files.filter(entry => entry.managedCatalogSha256).map(entry => entry.path).sort(), paths.sort());
  assert.deepEqual(overlay.files.filter(entry => entry.managedCatalogAdded).map(entry => entry.path).sort(), consumers.sort());
  for (const entry of overlay.files.filter(entry => entry.managedCatalogSha256)) {
    assert.equal(entry.attachmentsSha256 ?? entry.sessionStatusReadSha256 ?? entry.inboxStepsSha256 ?? entry.humanSessionLifetimeSha256 ?? entry.humanHostBoundarySha256 ?? entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.voiceFabricSha256 ?? entry.design538Sha256 ?? entry.contextWindowSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256, entry.combinedSha256);
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), currentOutput(entry.path, entry.attachmentsSha256 ?? entry.sessionStatusReadSha256 ?? entry.inboxStepsSha256 ?? entry.humanSessionLifetimeSha256 ?? entry.humanHostBoundarySha256 ?? entry.personalSidebarRevealSha256 ?? entry.personalSidebarReviewSha256 ?? entry.personalSidebarSha256 ?? entry.sendClientIdSha256 ?? entry.statusUnavailableSha256 ?? entry.managedHoldSha256 ?? entry.notificationAuthSha256 ?? entry.creationFieldsSha256 ?? entry.firstSendHandoffSha256 ?? entry.voiceFabricSha256 ?? entry.design538Sha256 ?? entry.contextWindowSha256 ?? entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256));
    assert.match(entry.preManagedCatalogCombinedSha256, /^[a-f0-9]{64}$/);
    if (entry.managedCatalogAdded) assert.equal(entry.preManagedCatalogCombinedSha256, entry.brandingSha256);
  }
  const fixtures = overlay.files.filter(entry => entry.catalogFixtureSha256);
  assert.deepEqual(fixtures.map(entry => entry.path), ['packages/ui/src/components/auth/SessionAuthGate.behavior.test.tsx']);
  for (const entry of fixtures) {
    assert.equal(entry.catalogFixtureSource, '24e8cf43def2efe83448542efa7be51ee1726271');
    assert.equal(entry.catalogFixtureSha256, entry.combinedSha256);
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.catalogFixtureSha256);
  }
  const historical = structuredClone(overlay);
  // Unwind openchamber#551 first: it is the newest layer, above PR486; the result is the PR486 ledger.
  assert.deepEqual(historical.attachmentsProvenance, {
    pullRequest: 551,
    issue: 'smarty-code#1397',
    reviewedHead: 'abad3511faa77463872b629d3f2faa2df8e11853',
    sourceEvidence: 'Round-3 bytes after the SEC551 round-2 security review; bound by hash. No installed acceptance claim.',
  });
  delete historical.attachmentsProvenance;
  historical.files = historical.files.filter(entry => !entry.attachmentsAdded);
  const attachments = historical.files.filter(entry => 'attachmentsSha256' in entry);
  assert.deepEqual(attachments.map(entry => entry.path).sort(), paths.filter(file => file.includes('/i18n/messages/')).sort());
  for (const entry of attachments) {
    assert.equal(entry.attachmentsSha256, entry.combinedSha256);
    assert.equal(entry.preAttachmentsCombinedSha256, entry.inboxStepsSha256);
    assert.ok(entry.attachmentsNote);
    entry.combinedSha256 = entry.preAttachmentsCombinedSha256;
    delete entry.preAttachmentsCombinedSha256;
    delete entry.attachmentsSha256;
    delete entry.attachmentsNote;
  }
  // Unwind PR486 next: it sits above inbox Steps; the result is the exact smarty-code ledger.
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
  assert.equal(digest(JSON.stringify(historical)),
    '6a636b11808d1e2b28ad0afc311e6592ebc838ab8194adaa809c0d693a04af10');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), '42cb0bcc611bd57ca55b84ac94f08906385546ab7f8f39ccadc27dcb6bc4c8e5');
  // Unwind Steps to the exact upstream ledger, retaining Forge placement and provenance.
  assert.equal(historical.inboxStepsSource, 'f2a293d2eb5f4570fcad5088ce39065ae1e59271');
  delete historical.inboxStepsSource;
  const inboxSteps = historical.files.filter(entry => 'inboxStepsSha256' in entry);
  assert.deepEqual(inboxSteps.map(entry => entry.path).sort(), paths.filter(file => file.includes('/i18n/messages/')).sort());
  for (const entry of inboxSteps) {
    assert.equal(entry.inboxStepsSha256, entry.combinedSha256);
    assert.equal(entry.preInboxStepsCombinedSha256, entry.statusUnavailableSha256);
    assert.ok(entry.inboxStepsNote);
    entry.combinedSha256 = entry.preInboxStepsCombinedSha256;
    delete entry.preInboxStepsCombinedSha256;
    delete entry.inboxStepsSha256;
    delete entry.inboxStepsNote;
  }
  assert.equal(digest(JSON.stringify(historical)), '6db9d621c04a942e308030a4d7a7cf60d55af973bf8d5064659c1cab342aa2e3');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), 'ded363c23fa52c512a26726c144ff50e0a8a8d2aecafacfc99a2e48d058ecb56');
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
  assert.equal(digest(JSON.stringify(historical)), '67dda5752d97d95c55e0415f2c91ceda67b13ccf36064bce2f4152aab4cd3ad2');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), 'b9a267f250b259ec739f3b9de8bd414529917395a33ab924a46dbc99f49676f5');
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
  assert.equal(digest(JSON.stringify(historical)), '2513793752310488e83c73a53feb82d7c460dee9c95d70db10e3b7220d29f9b9');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), '72239c6062dcc912d129a727209d7c92c926532b465469c363a1f49b3cfab822');

  // Security comment 5919567288 extends the released held-open correction, not its historical output.
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
  assert.equal(digest(JSON.stringify(historical)), '05d8f3cad425c23bb31213a20db92b20e082474c6b7c312bf13a69d40b9b40e7');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), '98dd971ce744a0dfa0570c41a644f4b8a92d2ed4718b2357a47d5f06f4ad9c7d');
  // Finding 1 corrects the held-open cancellation above the original reviewed sidebar output.
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
  // Personal sidebar extends only the session store, above the send-client-ID layer.
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
  // Unwind the finding-driven event repair before the initial Host patch.
  assert.deepEqual(historical.humanSessionLifetimeProvenance, {
    reviewedHead: '12463c2fb0e599623e631e772f1699e4e1669965',
    finding: 'P2 - Event-stream and dictation WebSockets retain authorization after the human session ends',
  });
  const lifetime = historical.files.filter(entry => entry.preHumanSessionLifetimeCombinedSha256);
  assert.deepEqual(lifetime.map(entry => entry.path), ['packages/web/server/lib/event-stream/runtime.js']);
  for (const entry of lifetime) {
    assert.equal(entry.preHumanSessionLifetimeCombinedSha256,
      '74c761d0a040bf4d995358de63ca8db5ad522f10721489bb3d7c41c26b609d67');
    assert.equal(entry.preHumanSessionLifetimeCombinedSha256, entry.humanHostBoundarySha256);
    assert.ok(entry.humanSessionLifetimeNote);
    // The stock-owner lifetime test separately requires the finalized hash and exact current bytes.
    entry.combinedSha256 = entry.preHumanSessionLifetimeCombinedSha256;
    delete entry.preHumanSessionLifetimeCombinedSha256;
    delete entry.humanSessionLifetimeSha256;
    delete entry.humanSessionLifetimeNote;
  }
  delete historical.humanSessionLifetimeProvenance;
  assert.equal(historical.humanHostBoundarySource, '12463c2fb0e599623e631e772f1699e4e1669965');
  const host = historical.files.filter(entry => entry.humanHostBoundarySha256);
  assert.deepEqual(host.map(entry => entry.path), [
    'packages/web/server/index.js', 'packages/web/server/lib/event-stream/runtime.js',
  ]);
  for (const entry of host) {
    assert.equal(entry.humanHostBoundarySha256, entry.combinedSha256);
    assert.equal(entry.preHumanHostBoundaryCombinedSha256,
      entry.notificationAuthSha256 ?? entry.originGuardSha256);
    assert.ok(entry.humanHostBoundaryNote);
    entry.combinedSha256 = entry.preHumanHostBoundaryCombinedSha256;
    delete entry.preHumanHostBoundaryCombinedSha256;
    delete entry.humanHostBoundarySha256;
    delete entry.humanHostBoundaryNote;
  }
  delete historical.humanHostBoundarySource;
  assert.equal(digest(JSON.stringify(historical)),
    '2d82cc4319d8f8ebe9488652c820f0612b2a016c944b70d012ce2d64bc48aa24');
  // The send client ID (smarty-code#827, openchamber#375) is the newest layer: one file, so unwind it first.
  assert.match(historical.sendClientIdSource, /^[a-f0-9]{40}$/);
  delete historical.sendClientIdSource;
  for (const entry of historical.files.filter(file => file.sendClientIdSha256)) {
    assert.equal(entry.sendClientIdSha256, entry.combinedSha256);
    assert.ok(entry.sendClientIdNote);
    entry.combinedSha256 = entry.preSendClientIdCombinedSha256;
    delete entry.preSendClientIdCombinedSha256;
    delete entry.sendClientIdSha256;
    delete entry.sendClientIdNote;
  }
  // smarty-code#957 keeps ordinaryCodeMade in the session-list allowlist (proxy.js only): the next layer (another file).
  assert.equal(historical.codeMadeListSource, 'ebf56e66943ee912b727dab8ebb0e336d50f733d');
  delete historical.codeMadeListSource;
  for (const entry of historical.files.filter(file => file.codeMadeListSha256)) {
    assert.equal(entry.codeMadeListSha256, entry.combinedSha256);
    entry.combinedSha256 = entry.preCodeMadeListCombinedSha256;
    delete entry.preCodeMadeListCombinedSha256; delete entry.codeMadeListSha256; delete entry.codeMadeListNote;
  }
  // smarty-code#539 imports the "Status unavailable" string into the eleven locale outputs: the newest layer, unwound first.
  assert.equal(historical.statusUnavailableSource, '3ce8d22f06df56604bc170ad6fcfc4631336682b');
  delete historical.statusUnavailableSource;
  const statusUnavailable = historical.files.filter(file => file.statusUnavailableSha256);
  assert.deepEqual(statusUnavailable.map(entry => entry.path).sort(), paths.filter(file => file.includes('/i18n/messages/')).sort());
  for (const entry of statusUnavailable) {
    assert.equal(entry.statusUnavailableSha256, entry.combinedSha256);
    assert.ok(entry.statusUnavailableNote);
    entry.combinedSha256 = entry.preStatusUnavailableCombinedSha256;
    delete entry.preStatusUnavailableCombinedSha256;
    delete entry.statusUnavailableSha256;
    delete entry.statusUnavailableNote;
  }
  // The co-edit disk bridge's dependencies (smartyfs#18 slice 1) are the newest layer: one file, so unwind it first.
  assert.match(historical.coeditSource, /^[a-f0-9]{40}$/);
  delete historical.coeditSource;
  for (const entry of historical.files.filter(file => file.coeditSha256)) {
    assert.equal(entry.coeditSha256, entry.combinedSha256);
    assert.ok(entry.coeditNote);
    entry.combinedSha256 = entry.preCoeditCombinedSha256;
    delete entry.preCoeditCombinedSha256;
    delete entry.coeditSha256;
    delete entry.coeditNote;
  }
  // The shared worktree root (smarty-code#629) is the next layer: it only adds the git service entry, so unwind it next.
  assert.match(historical.worktreeRootSource, /^[a-f0-9]{40}$/);
  delete historical.worktreeRootSource;
  historical.files = historical.files.filter(entry => !entry.worktreeRootAdded);
  // The #739 Fabric message row (smarty-code#739) is the next layer: one file, so unwind it next.
  assert.match(historical.voiceFabricSource, /^[a-f0-9]{40}$/);
  delete historical.voiceFabricSource;
  for (const entry of historical.files.filter(file => file.voiceFabricSha256)) {
    assert.equal(entry.voiceFabricSha256, entry.combinedSha256);
    assert.ok(entry.voiceFabricNote);
    entry.combinedSha256 = entry.preVoiceFabricCombinedSha256;
    delete entry.preVoiceFabricCombinedSha256;
    delete entry.voiceFabricSha256;
    delete entry.voiceFabricNote;
  }
  // The notification lookup's session directory (smarty-code#536) is the next layer: one file, so unwind it first.
  assert.match(historical.notificationAuthSource, /^[a-f0-9]{40}$/);
  delete historical.notificationAuthSource;
  for (const entry of historical.files.filter(file => file.notificationAuthSha256)) {
    assert.equal(entry.notificationAuthSha256, entry.combinedSha256);
    assert.ok(entry.notificationAuthNote);
    entry.combinedSha256 = entry.preNotificationAuthCombinedSha256;
    delete entry.preNotificationAuthCombinedSha256;
    delete entry.notificationAuthSha256;
    delete entry.notificationAuthNote;
  }
  // Voice call notes (system notes, smarty-code#360) are the next layer: they only add the session-assist entry, so
  // unwind it first.
  assert.match(historical.systemNoteSource, /^[a-f0-9]{40}$/);
  delete historical.systemNoteSource;
  historical.files = historical.files.filter(entry => !entry.systemNoteAdded);
  // The waiting open (smarty-code#608) is the newest layer: one file, so unwind it first.
  assert.match(historical.managedHoldSource, /^[a-f0-9]{40}$/);
  delete historical.managedHoldSource;
  for (const entry of historical.files.filter(file => file.managedHoldSha256)) {
    assert.equal(entry.managedHoldSha256, entry.combinedSha256);
    assert.ok(entry.managedHoldNote);
    entry.combinedSha256 = entry.preManagedHoldCombinedSha256;
    delete entry.preManagedHoldCombinedSha256;
    delete entry.managedHoldSha256;
    delete entry.managedHoldNote;
  }
  // The creation-fields CORS header (smarty-code#523) is the next layer down.
  assert.match(historical.creationFieldsSource, /^[a-f0-9]{40}$/);
  delete historical.creationFieldsSource;
  for (const entry of historical.files.filter(file => file.creationFieldsSha256)) {
    assert.equal(entry.creationFieldsSha256, entry.combinedSha256);
    assert.ok(entry.creationFieldsNote);
    entry.combinedSha256 = entry.preCreationFieldsCombinedSha256;
    delete entry.preCreationFieldsCombinedSha256;
    delete entry.creationFieldsSha256;
    delete entry.creationFieldsNote;
  }
  // The #538 account menu and sender row (smarty-code#538) are the next layer down.
  assert.match(historical.design538Source, /^[a-f0-9]{40}$/);
  delete historical.design538Source;
  for (const entry of historical.files.filter(file => file.design538Sha256)) {
    assert.equal(entry.design538Sha256, entry.combinedSha256);
    assert.ok(entry.design538Note);
    entry.combinedSha256 = entry.preDesign538CombinedSha256;
    delete entry.preDesign538CombinedSha256;
    delete entry.design538Sha256;
    delete entry.design538Note;
  }
  // The first-send handoff (smarty-dev#856) is the newest layer: one file, so unwind it first.
  assert.match(historical.firstSendHandoffSource, /^[a-f0-9]{40}$/);
  delete historical.firstSendHandoffSource;
  for (const entry of historical.files.filter(file => file.firstSendHandoffSha256)) {
    assert.equal(entry.firstSendHandoffSha256, entry.combinedSha256);
    assert.ok(entry.firstSendHandoffNote);
    entry.combinedSha256 = entry.preFirstSendHandoffCombinedSha256;
    delete entry.preFirstSendHandoffCombinedSha256;
    delete entry.firstSendHandoffSha256;
    delete entry.firstSendHandoffNote;
  }
  // The passwordless origin guard (smarty-code#391) is the newest layer: it only adds one entry, so unwind it first.
  assert.match(historical.originGuardSource, /^[a-f0-9]{40}$/);
  delete historical.originGuardSource;
  historical.files = historical.files.filter(entry => !entry.originGuardAdded);
  // The deterministic stall tests are the newest layer: they only add two test entries, so unwind them first.
  assert.match(historical.testDeterminismSource, /^[a-f0-9]{40}$/);
  delete historical.testDeterminismSource;
  historical.files = historical.files.filter(entry => !entry.testDeterminismAdded);
  // The context window (G14) is the newest layer, so unwind it first.
  assert.match(historical.contextWindowSource, /^[a-f0-9]{40}$/);
  delete historical.contextWindowSource;
  for (const entry of historical.files.filter(file => file.contextWindowSha256)) {
    assert.equal(entry.contextWindowSha256, entry.combinedSha256);
    assert.ok(entry.contextWindowNote);
    entry.combinedSha256 = entry.preContextWindowCombinedSha256;
    delete entry.preContextWindowCombinedSha256;
    delete entry.contextWindowSha256;
    delete entry.contextWindowNote;
  }
  // The unsaved label (slice 1 L1) is the newest layer, so unwind it first.
  assert.match(historical.unsavedLabelSource, /^[a-f0-9]{40}$/);
  delete historical.unsavedLabelSource;
  for (const entry of historical.files.filter(file => file.unsavedLabelSha256)) {
    assert.equal(entry.unsavedLabelSha256, entry.combinedSha256);
    assert.ok(entry.unsavedLabelNote);
    entry.combinedSha256 = entry.preUnsavedLabelCombinedSha256;
    delete entry.preUnsavedLabelCombinedSha256;
    delete entry.unsavedLabelSha256;
    delete entry.unsavedLabelNote;
  }
  // The model-prefs unload flush (smarty-code#126 F6) is the newest layer, so unwind it first.
  assert.match(historical.modelPrefsUnloadSource, /^[a-f0-9]{40}$/);
  delete historical.modelPrefsUnloadSource;
  for (const entry of historical.files.filter(file => file.modelPrefsUnloadSha256)) {
    assert.equal(entry.modelPrefsUnloadSha256, entry.combinedSha256);
    assert.ok(entry.modelPrefsUnloadNote);
    entry.combinedSha256 = entry.preModelPrefsUnloadCombinedSha256;
    delete entry.preModelPrefsUnloadCombinedSha256;
    delete entry.modelPrefsUnloadSha256;
    delete entry.modelPrefsUnloadNote;
  }
  // smarty-code#701 forwards the inbox stream: the newest proxy layer, unwound first.
  assert.equal(historical.inboxStreamSource, 'd16efdf6a265496d06a68e8f76a7721905d0bab1');
  delete historical.inboxStreamSource;
  for (const entry of historical.files.filter(file => file.inboxStreamSha256)) {
    entry.combinedSha256 = entry.preInboxStreamCombinedSha256;
    delete entry.preInboxStreamCombinedSha256;
    delete entry.inboxStreamSha256;
    delete entry.inboxStreamNote;
  }
  // smarty-code#863/#870 add the successor and the reloading mark to the session-list allowlist: unwound before F4.
  assert.equal(historical.fleetListSource, '47eb1c68d3f64129018078eed1e218cb23baff50');
  delete historical.fleetListSource;
  for (const entry of historical.files.filter(file => file.fleetListSha256)) {
    entry.combinedSha256 = entry.preFleetListCombinedSha256;
    delete entry.preFleetListCombinedSha256;
    delete entry.fleetListSha256;
    delete entry.fleetListNote;
  }
  // smarty-code#126 F4 lets Herdr's state through the session-list allowlist; unwound next.
  assert.equal(historical.herdrListSource, 'b6d4f1b5a3dd67c222b75ed87ec04e3415c81f38');
  delete historical.herdrListSource;
  for (const entry of historical.files.filter(file => file.herdrListSha256)) {
    entry.combinedSha256 = entry.preHerdrListCombinedSha256;
    delete entry.preHerdrListCombinedSha256;
    delete entry.herdrListSha256;
    delete entry.herdrListNote;
  }
  // smarty-code#126 (c) imports the sidebar wording into the locale outputs; it is the newest layer, so unwind it first.
  const sidebarHerdr = historical.files.filter(entry => entry.sidebarHerdrSha256);
  assert.deepEqual(sidebarHerdr.map(entry => entry.path).sort(), paths.filter(file => file.includes('/i18n/messages/')).sort());
  assert.equal(historical.sidebarHerdrSource, 'e5aff1279a1a9c13e4fabfde34be79de19c9229a');
  delete historical.sidebarHerdrSource;
  for (const entry of sidebarHerdr) {
    assert.equal(entry.sidebarHerdrSha256, entry.combinedSha256);
    assert.match(entry.preSidebarHerdrCombinedSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.sidebarHerdrNote);
    entry.combinedSha256 = entry.preSidebarHerdrCombinedSha256;
    delete entry.preSidebarHerdrCombinedSha256;
    delete entry.sidebarHerdrSha256;
    delete entry.sidebarHerdrNote;
  }
  // smarty-code#126 item 8 adds one copy key to the locale outputs; it is the newest layer, so unwind it first.
  const managedAdds = historical.files.filter(entry => entry.managedAddSha256);
  assert.deepEqual(managedAdds.map(entry => entry.path).sort(), paths.filter(file => file.includes('/i18n/messages/')).sort());
  assert.equal(historical.managedAddSource, 'a5104366fda151b13a679566c9d411e3005f942f');
  delete historical.managedAddSource;
  for (const entry of managedAdds) {
    assert.equal(entry.managedAddSha256, entry.combinedSha256);
    assert.match(entry.preManagedAddCombinedSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.managedAddNote);
    entry.combinedSha256 = entry.preManagedAddCombinedSha256;
    delete entry.preManagedAddCombinedSha256;
    delete entry.managedAddSha256;
    delete entry.managedAddNote;
  }
  // The Stop wording change (smarty-code#122) is the newest layer: strip it first, restoring the prior ledger exactly.
  const stopWording = historical.files.filter(entry => entry.stopWordingSha256);
  assert.deepEqual(stopWording.map(entry => entry.path), ['packages/ui/src/components/chat/ChatMessage.tsx']);
  for (const entry of stopWording) {
    assert.equal(entry.stopWordingSha256, entry.combinedSha256);
    // The layer's own binding stays pinned. The file on disk carries it only while no newer layer rebound the file
    // (the newer layer then checks the disk and names this hash as its predecessor).
    assert.equal(entry.stopWordingSha256, 'dfc540f2a7799fe707065b44ef9eabf8bf6668f34988499c08615bc4cb884ab8');
    if (overlay.files.find(current => current.path === entry.path)?.combinedSha256 === entry.stopWordingSha256) {
      assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.stopWordingSha256);
    }
    assert.equal(entry.stopWordingSource, '1bb8b45e6b73d501337c17bf74db875ec9496178');
    assert.ok(entry.stopWordingNote);
    entry.combinedSha256 = entry.preStopWordingCombinedSha256;
    delete entry.preStopWordingCombinedSha256;
    delete entry.stopWordingSha256;
    delete entry.stopWordingSource;
    delete entry.stopWordingNote;
  }
  const catalogReloads = historical.files.filter(entry => entry.catalogReloadSha256);
  assert.deepEqual(catalogReloads.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of catalogReloads) {
    assert.equal(entry.catalogReloadSource, 'b4b815b491de25924df4a9a33554427efff10898');
    assert.equal(entry.catalogReloadSha256, '8caf10c8c849c4e133e07a3189d8bfdb58ece39c8c655b7d2f427a06f242bf0b');
    assert.equal(entry.preCatalogReloadCombinedSha256, entry.persistedTargetSha256);
    assert.ok(entry.catalogReloadNote);
    entry.combinedSha256 = entry.preCatalogReloadCombinedSha256;
    delete entry.preCatalogReloadCombinedSha256;
    delete entry.catalogReloadSha256;
    delete entry.catalogReloadSource;
    delete entry.catalogReloadNote;
  }
  const sessionVoice = historical.files.filter(entry => entry.sessionVoiceSha256);
  assert.deepEqual(sessionVoice.map(entry => entry.path).sort(), paths.filter(path => path.includes('/i18n/messages/') || path.endsWith('/server/index.js')).sort());
  assert.equal(historical.sessionVoiceSource, '02e0e00b05a72bc9055f9363184dd28ff982682e');
  assert.ok(historical.sessionVoiceNote);
  for (const entry of sessionVoice) {
    assert.match(entry.preSessionVoiceCombinedSha256, /^[a-f0-9]{64}$/);
    entry.combinedSha256 = entry.preSessionVoiceCombinedSha256;
    delete entry.preSessionVoiceCombinedSha256;
    delete entry.sessionVoiceSha256;
  }
  delete historical.sessionVoiceSource;
  delete historical.sessionVoiceNote;
  const persistedTargets = historical.files.filter(entry => entry.persistedTargetSha256);
  assert.deepEqual(persistedTargets.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of persistedTargets) {
    assert.equal(entry.persistedTargetSource, '4a692929d83673ae89b712f110f7138643872c2e');
    assert.equal(entry.persistedTargetSha256, 'bb0d6abff832b0eaeea9309a5cc4adf8413220de783fb4daa76aa14cf790d0eb');
    assert.equal(entry.prePersistedTargetCombinedSha256, entry.restorationSha256);
    assert.ok(entry.persistedTargetNote);
    entry.combinedSha256 = entry.prePersistedTargetCombinedSha256;
    delete entry.prePersistedTargetCombinedSha256;
    delete entry.persistedTargetSha256;
    delete entry.persistedTargetSource;
    delete entry.persistedTargetNote;
  }
  const restorations = historical.files.filter(entry => entry.restorationSha256);
  assert.deepEqual(restorations.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of restorations) {
    assert.equal(entry.restorationSource, '794a8aa958d5a4b32f08089c9e97148112a4e22e');
    assert.equal(entry.restorationSha256, '2e7a10b64bf892b5b219e0a2d292f7472ae5face660debaea2ee949a4d28ff97');
    assert.equal(entry.preRestorationCombinedSha256, entry.coldDraftSha256);
    assert.ok(entry.restorationNote);
    entry.combinedSha256 = entry.preRestorationCombinedSha256;
    delete entry.preRestorationCombinedSha256;
    delete entry.restorationSha256;
    delete entry.restorationSource;
    delete entry.restorationNote;
  }
  assert.equal(digest(JSON.stringify(historical)), 'ca4bb9e18ac1b843bf0f9be8ed14118810de6cf4510b7a12ccb97fa901eb3e22');
  const coldDrafts = historical.files.filter(entry => entry.coldDraftSha256);
  assert.deepEqual(coldDrafts.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of coldDrafts) {
    assert.equal(entry.coldDraftSource, 'b634303615d2294dd96be69d583377a3d0bece50');
    assert.equal(entry.coldDraftSha256, '4d93472da28ca715b7bf6009e6d72cebaa2c478fd92a135bff0ba79b906d8639');
    assert.equal(entry.preColdDraftCombinedSha256, entry.managedDraftSha256);
    assert.ok(entry.coldDraftNote);
    entry.combinedSha256 = entry.preColdDraftCombinedSha256;
    delete entry.preColdDraftCombinedSha256;
    delete entry.coldDraftSha256;
    delete entry.coldDraftSource;
    delete entry.coldDraftNote;
  }
  assert.equal(digest(JSON.stringify(historical)), '9642619415e82534a579641aaf42657420d8dcd579e47e4d0f8096aeb7e5b9d2');
  const successors = historical.files.filter(entry => entry.managedDraftSha256);
  assert.deepEqual(successors.map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  for (const entry of successors) {
    assert.equal(entry.managedDraftSource, 'c170aba9ad999fb0fa010b9b613309ebfd5cfdad');
    assert.equal(entry.managedDraftSha256, '1d5158cb7ab2b37a8497340bade9a79a5b827424400f74a8f4c1541e828b96d7');
    assert.equal(entry.preManagedDraftCombinedSha256, entry.managedCatalogSha256);
    assert.ok(entry.managedDraftNote);
    entry.combinedSha256 = entry.preManagedDraftCombinedSha256;
    delete entry.preManagedDraftCombinedSha256;
    delete entry.managedDraftSha256;
    delete entry.managedDraftSource;
    delete entry.managedDraftNote;
  }
  assert.equal(digest(JSON.stringify(historical)), 'aaaf4faf9b9d9f67109b6e657df1571367ebea8670933353a0f67c9332d3b05c');
  for (const entry of historical.files.filter(entry => entry.catalogFixtureSha256)) {
    entry.combinedSha256 = entry.preCatalogFixtureCombinedSha256;
    delete entry.preCatalogFixtureCombinedSha256;
    delete entry.catalogFixtureSha256;
    delete entry.catalogFixtureSource;
  }
  delete historical.managedCatalogSource;
  delete historical.managedCatalogNote;
  historical.files = historical.files.filter(entry => !entry.managedCatalogAdded);
  for (const entry of historical.files.filter(entry => entry.managedCatalogSha256)) {
    entry.combinedSha256 = entry.preManagedCatalogCombinedSha256;
    delete entry.preManagedCatalogCombinedSha256;
    delete entry.managedCatalogSha256;
  }
  assert.equal(digest(JSON.stringify(historical)), 'bd22cbafd8d0118e8cf4f55120408197094654e2f65dbee04bdad37f4f0a838b');
});
