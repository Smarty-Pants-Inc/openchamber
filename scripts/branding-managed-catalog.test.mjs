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
    assert.equal(entry.managedCatalogSha256, entry.combinedSha256);
    assert.equal(digest(readFileSync(new URL(`../${entry.path}`, import.meta.url))), entry.managedCatalogSha256);
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
