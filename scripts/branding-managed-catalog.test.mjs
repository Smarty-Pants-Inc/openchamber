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
    assert.equal(entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256, entry.combinedSha256);
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256);
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
