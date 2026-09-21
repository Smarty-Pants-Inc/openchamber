import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    '.github/workflows/oc-review.yml',
    'packages/ui/src/components/auth/SessionAuthGate.tsx',
    'packages/ui/src/components/chat/ChatMessage.tsx',
    'packages/ui/src/sync/session-actions.test.ts', 'packages/web/package.json', 'packages/web/server/index.js',
    'packages/web/server/lib/notifications/apns-runtime.js',
    'packages/web/server/lib/opencode/core-routes.js',
    'packages/web/server/lib/opencode/core-routes.test.js',
    'packages/web/server/lib/opencode/proxy.js', 'packages/web/server/lib/opencode/routes.js', 'packages/web/src/api/settings.ts',
    'packages/web/server/lib/opencode/static-routes-runtime.js',
    ...attributionPaths,
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
    assert.equal(entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, entry.combinedSha256, file);
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
    assert.equal(entry.foundationCopySha256 ?? entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256 ?? entry.nativeCreationSha256, sha256(read(file)), file);
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
    assert.equal(entry.foundationCopySha256, sha256(read(file)), file);
    assert.notEqual(entry.foundationCopySha256, entry.nativeCreationSha256, file);
  }
});

test('native draft lifecycle overlay preserves prior source evidence and extends only the existing store overlap', () => {
  assert.equal(overlay.nativeLifecycleSource, '24170f63647a3acc20a819ef5139d300713157c0');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifecycleSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256 ?? entry.nativeLifecycleSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeLifecycleSha256, 'ad4850a64d50b0ce06107888171ed01a36fee3a69758e4c3153e787249e5d0fe');
  assert.equal(entry.nativeCreationSha256, '32dcfc9c63468cb32be5d92612455bbc7cf076e82ee626c9f34dc0ee5c258305');
});

test('native completion overlay binds its exact source without replacing earlier lifecycle evidence', () => {
  assert.equal(overlay.nativeCompletionSource, '17c5ce2b8ed0d5331d5b46a3337bb75a3474ce67');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeCompletionSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.nativeLifetimeSha256 ?? entry.nativeCompletionSha256, sha256(read(entry.path)));
  assert.equal(entry.nativeCompletionSha256, '8c06820d14b78e8028c8e5c8f49d5eac6d9f643e9a845e9ff21c60956f95c807');
});

test('native input lifetime overlay preserves earlier completion evidence', () => {
  assert.equal(overlay.nativeLifetimeSource, 'd5f1a8964eafd6bafddd26dbe80318ae44040ec1');
  assert.deepEqual(overlay.files.filter(entry => entry.nativeLifetimeSha256).map(entry => entry.path), ['packages/ui/src/sync/session-ui-store.ts']);
  const entry = overlays.get('packages/ui/src/sync/session-ui-store.ts');
  assert.equal(entry.nativeLifetimeSha256, sha256(read(entry.path)));
});

test('runtime recovery binds only the reviewed auth gate donor overlap', () => {
  const source = '3a3200ddae1611a079a76601ceba2b7ca1e43840';
  const file = 'packages/ui/src/components/auth/SessionAuthGate.tsx';
  assert.equal(overlay.runtimeRecoverySource, source);
  assert.deepEqual(overlay.files.filter(entry => entry.behaviorSource === source).map(entry => entry.path), [file]);
  const entry = overlays.get(file);
  assert.equal(entry.brandingSha256, '34f679f305ff987129350fafa279078411924b8f51b925474fedcfa9f48ed586');
  assert.equal(entry.behaviorSha256, '56e3bb3d831bdaa066ac52655f4096e8a9fc3f16c3f91c096cccc7b5c8150a18');
  assert.equal(entry.combinedSha256, entry.behaviorSha256);
  assert.equal(sha256(read(file)), entry.behaviorSha256);
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
      assert.equal(changed.foundationCopySha256 ?? changed.nativeLifetimeSha256 ?? changed.nativeCompletionSha256 ?? changed.nativeLifecycleSha256 ?? changed.nativeCreationSha256 ?? changed.behaviorSha256, changed.combinedSha256, file);
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
