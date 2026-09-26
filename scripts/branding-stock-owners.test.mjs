import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import './branding-managed-catalog.test.mjs';
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

test('behavior overlay is explicit and preserves the original branding ledger', () => {
  assert.equal(overlay.brandingSource, '961cabb1e08b7c20ae7cd17cd8788ce8af0d469a');
  assert.equal(overlay.behaviorSource, '1ab7ae3799ee4e633785451ef28cf52f49e53797');
  assert.equal(overlays.size, overlay.files.length);
  assert.deepEqual([...overlays.keys()].sort(), [
    '.github/workflows/oc-review.yml', 'package.json',
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
  ].sort());
  const original = new Map(json('branding/coverage.json').files.map(entry => [entry.path, entry]));
  for (const entry of overlay.files) {
    assert.ok(entry.reason, entry.path);
    assert.equal(entry.brandingSha256, original.get(entry.path)?.outputSha256, entry.path);
    assert.match(entry.behaviorSha256, /^[a-f0-9]{64}$/, entry.path);
    assert.equal(sha256(read(entry.path)), entry.combinedSha256, entry.path);
  }
});

test('attribution overlay binds only its exact reviewed source without replacing donor evidence', () => {
  assert.equal(overlay.attributionSource, '3c71ed6017b1f30ba9bbb6be1ab259a98075279b');
  for (const file of attributionPaths) {
    const entry = overlays.get(file);
    assert.equal(entry.behaviorSource, overlay.attributionSource, file);
    assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, entry.combinedSha256, file);
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
    assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, sha256(read(file)), file);
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
    assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.foundationCopySha256, sha256(read(file)), file);
    assert.notEqual(entry.foundationCopySha256, entry.nativeCreationSha256, file);
  }
});

test('native draft lifecycle overlay preserves prior source evidence and extends only the existing store overlap', () => {
  assert.equal(overlay.nativeLifecycleSource, '24170f63647a3acc20a819ef5139d300713157c0');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifecycleSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeLifecycleSha256, 'ad4850a64d50b0ce06107888171ed01a36fee3a69758e4c3153e787249e5d0fe');
  assert.equal(entry.nativeCreationSha256, '32dcfc9c63468cb32be5d92612455bbc7cf076e82ee626c9f34dc0ee5c258305');
});

test('native completion overlay binds its exact source without replacing earlier lifecycle evidence', () => {
  assert.equal(overlay.nativeCompletionSource, '17c5ce2b8ed0d5331d5b46a3337bb75a3474ce67');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeCompletionSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeCompletionSha256, '8c06820d14b78e8028c8e5c8f49d5eac6d9f643e9a845e9ff21c60956f95c807');
});

test('native input lifetime overlay preserves earlier completion evidence', () => {
  assert.equal(overlay.nativeLifetimeSource, 'd5f1a8964eafd6bafddd26dbe80318ae44040ec1');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifetimeSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256 ?? entry.nativeLifetimeSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeLifetimeSha256, '460d09e8b48454153c32b29707bcd440623ea8776d93ba46ecfa47da465517df');
});

test('ordinary selection binds the reviewed store successor without replacing earlier evidence', () => {
  assert.equal(overlay.ordinarySelectionSource, 'abfdf54c266428181e293bc28ee437c9f55de3a5');
  const file = 'packages/ui/src/sync/session-ui-store.ts';
  assert.deepEqual(overlay.files.filter(entry => entry.ordinarySelectionSha256).map(entry => entry.path), [file]);
  const entry = overlays.get(file);
  assert.equal(entry.ordinarySelectionSha256, 'bf78cd5db2b20b09ebbb95bbfb71227b4d00c86e61f32e6d8f948d0f05b21ac8');
  assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256, entry.combinedSha256);
  assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.persistedTargetSha256 ?? entry.restorationSha256 ?? entry.coldDraftSha256 ?? entry.managedDraftSha256 ?? entry.managedCatalogSha256 ?? entry.ordinarySelectionSha256, sha256(read(file)));
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
  assert.equal(sha256(read(file)), entry.humanAuthSha256);
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
    assert.equal(entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.humanAuthSha256, entry.combinedSha256);
    assert.equal(sha256(read(entry.path)), entry.sidebarHerdrSha256 ?? entry.managedAddSha256 ?? entry.catalogReloadSha256 ?? entry.sessionVoiceSha256 ?? entry.managedCatalogSha256 ?? entry.humanAuthSha256);
  }
});

test('hosted UI proof preserves the preceding workflow evidence', () => {
  const entry = overlays.get('.github/workflows/oc-review.yml');
  assert.equal(entry.behaviorSource, '94dd8952fb23d3e2aac8a2533cccef5dde443960');
  assert.equal(entry.behaviorSha256, '1b9c75f1993b06158eaf78df7af03ac92812e7019e00ef0ee5a8cb854752b80f');
  assert.equal(entry.humanAuthUiProofSource, '0d0f988aa98c345bf2bfc79d0c9b4e753347d744');
  assert.equal(entry.humanAuthUiProofSha256, entry.combinedSha256);
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
      assert.equal(changed.herdrListSha256 ?? changed.catalogReloadSha256 ?? changed.sessionVoiceSha256 ?? changed.persistedTargetSha256 ?? changed.restorationSha256 ?? changed.coldDraftSha256 ?? changed.managedDraftSha256 ?? changed.catalogFixtureSha256 ?? changed.managedCatalogSha256 ?? changed.humanAuthUiProofSha256 ?? changed.humanAuthSha256 ?? changed.ordinarySelectionSha256 ?? changed.foundationCopySha256 ?? changed.nativeLifetimeSha256 ?? changed.nativeCompletionSha256 ?? changed.nativeLifecycleSha256 ?? changed.nativeCreationSha256 ?? changed.behaviorSha256, changed.combinedSha256, file);
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
      overlays.get(entry.path)?.combinedSha256 ?? entry.outputSha256, entry.path);
  }
});

test('the session-list allowlist layer binds its exact commit over the reviewed proxy behavior (smarty-code#126 F4)', () => {
  const entry = overlays.get('packages/web/server/lib/opencode/proxy.js');
  assert.equal(overlay.herdrListSource, 'b6d4f1b5a3dd67c222b75ed87ec04e3415c81f38');
  assert.equal(entry.preHerdrListCombinedSha256, entry.behaviorSha256);
  assert.equal(entry.herdrListSha256, entry.combinedSha256);
  assert.ok(entry.herdrListNote);
  assert.deepEqual(overlay.files.filter(file => file.herdrListSha256).map(file => file.path), ['packages/web/server/lib/opencode/proxy.js']);
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
  assert.equal(entry.unsavedLabelSha256, entry.combinedSha256);
  assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  assert.equal(entry.preUnsavedLabelCombinedSha256, 'dfc540f2a7799fe707065b44ef9eabf8bf6668f34988499c08615bc4cb884ab8'); // The Stop-wording layer it replaces.
});

test('the context window binds its exact fix commit over the header only (smarty-dev#777 G14)', () => {
  assert.match(overlay.contextWindowSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(overlay.files.filter(file => file.contextWindowSha256).map(file => file.path), ['packages/ui/src/components/layout/Header.tsx']);
  const entry = overlays.get('packages/ui/src/components/layout/Header.tsx');
  assert.equal(entry.contextWindowSha256, entry.combinedSha256);
  assert.equal(sha256(read(entry.path)), entry.combinedSha256);
  assert.equal(entry.preContextWindowCombinedSha256, '5fd0340114593d973dcaef295f78b0f647207f35bdc6b3a0afdb3b81639309d4');
});
