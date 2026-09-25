import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
    assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256, entry.combinedSha256);
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256);
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
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.stopWordingSha256);
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
    assert.equal(entry.catalogReloadSource, 'c9b6420701af8cf4e038aba9bfb59a0e1359690d');
    assert.equal(entry.catalogReloadSha256, 'da0d3a5fcae66f63619948616826d0688c7ed3c5caff735514e8b3ed4b6a52dc');
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
