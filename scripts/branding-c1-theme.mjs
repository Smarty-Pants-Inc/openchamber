import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Main released all component writers before this actual source checkpoint was bound.
export const C1_SOURCE_AUTHORITY = 'ac217edc86ba105269a0af4d16070850f0d1d239';
export const C1_ORIGINAL_SOURCE = '301db7c8ab0d2455d41ebaa602913bd14ccc9e1a';
export const C1_BASE_SOURCE = '9eb430fc7d2acc51a6786691d5c5ec2005d291df';
export const C1_PREDECESSOR_JSON = '6db9d621c04a942e308030a4d7a7cf60d55af973bf8d5064659c1cab342aa2e3';
export const C1_PREDECESSOR_BYTES = 'ded363c23fa52c512a26726c144ff50e0a8a8d2aecafacfc99a2e48d058ecb56';
export const C1_PREDECESSORS = [
  ['packages/ui/src/components/auth/SessionAuthGate.tsx', '56e3bb3d831bdaa066ac52655f4096e8a9fc3f16c3f91c096cccc7b5c8150a18', '0f21be9bd70533aaf0246c098be334e2e76759baf7a9adb5d8ae94b3077cef53'],
  ['packages/ui/src/components/chat/CommandAutocomplete.tsx', '037d9b80c550b9f0be8f60061c0a4f721d211823967671e758552b4cc90b1c17', '722d0c1b4c33a4b3db4dc315060c1a1b2914c587123d58d8fb02bb1eeab519fe'],
  ['packages/ui/src/components/layout/Header.tsx', '2fa26e97a38ae6771b90b21f25caa16253a9f1745e58b96ea578ecda80525064', '6adbaa80a1ff0d5ff674f55681a7e01c56c8560a125250cd6e3ffc517a127a4e'],
  ['packages/ui/src/components/sections/mcp/McpOAuthCallbackPage.tsx', 'f4047df1e82f2df1697df89249618b030393920ef200cd54a319fec8e2059266', 'd5a0e5e12ead088b4773ab18c078d67f09db977b156388ee7c8d3aed3bf5b389'],
  ['packages/ui/src/components/sections/mcp/McpSidebar.tsx', '407ef41fb0218b23db7d6416e61ddd51521a02dbea76785ddce0979bd47b92e2', 'b1d77a31d649001427d371c8d59874eb261da557610a91647ddb6146c812ab28'],
  ['packages/ui/src/components/sections/openchamber/AboutSettings.tsx', '79701a8a9c6c72964983fa5adab0916e0020f39d3f69754e06a0ebee7377f1e0', '76eb041fd129ae723e44db14239541a29511c8cfdaf652444499a748a09fc0d0'],
  ['packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx', 'ac2f586032201b52439090d0880ffe6da4aa2a7ca4cc274ce7d40c0b73c86401', 'ff50d43345a62acb24b1399bc76a289c2dd9fc0e1bf5521c99d307d164c56b44'],
  ['packages/ui/src/components/update/OpenCodeUpdateToast.tsx', 'ffffdfaf41075357bd54344cf7e3719abd3954177fbaaf2fd7a54d90e638182f', '895ae2ba2e13843c7978c373db005569800f6fe872b7fbda135842f9b691e368'],
];
export const C1_PATHS = C1_PREDECESSORS.map(([file]) => file);
export const C1_ADDED_PATHS = C1_PATHS.filter(file => ![
  'packages/ui/src/components/auth/SessionAuthGate.tsx',
  'packages/ui/src/components/layout/Header.tsx',
].includes(file));
export const C1_NOTE = 'C1: semantic color and text-role bindings only; existing branding, handlers and runtime behavior retained. Source provenance is not browser/native or release acceptance.';
const digest = value => createHash('sha256').update(value).digest('hex');

export function unwindC1Theme(overlay) {
  const sourceAuthority = C1_SOURCE_AUTHORITY;
  assert.match(sourceAuthority, /^[a-f0-9]{40}$/, 'C1 source checkpoint is not bound');
  assert.deepEqual(overlay.c1ThemeProvenance, {
    originalSource: C1_ORIGINAL_SOURCE,
    baseSource: C1_BASE_SOURCE,
    source: sourceAuthority,
    predecessorLedgerSha256: C1_PREDECESSOR_JSON,
    predecessorLedgerBytesSha256: C1_PREDECESSOR_BYTES,
  });
  const successors = overlay.files.filter(entry => 'c1ThemeSha256' in entry);
  assert.deepEqual(successors.map(entry => entry.path).sort(), [...C1_PATHS].sort());
  assert.deepEqual(overlay.files.filter(entry => entry.c1ThemeAdded).map(entry => entry.path).sort(), [...C1_ADDED_PATHS].sort());
  assert.equal(new Set(overlay.files.map(entry => entry.path)).size, overlay.files.length);
  for (const [file, predecessor, current] of C1_PREDECESSORS) {
    const entry = successors.find(candidate => candidate.path === file);
    assert.equal(entry.preC1ThemeCombinedSha256, predecessor, `${file}: C1 predecessor changed`);
    assert.equal(entry.c1ThemeSha256, current, `${file}: C1 current binding changed`);
    assert.notEqual(entry.c1ThemeSha256, predecessor, file);
    assert.equal(entry.c1ThemeSha256, entry.combinedSha256, file);
    assert.equal(entry.c1ThemeSource, sourceAuthority, file);
    assert.equal(entry.c1ThemeNote, C1_NOTE, file);
    if (entry.c1ThemeAdded) {
      assert.equal(entry.behaviorSource, C1_ORIGINAL_SOURCE, file);
      assert.equal(entry.behaviorSha256, predecessor, file);
      assert.equal(entry.reason, C1_NOTE, file);
    }
  }
  const historical = structuredClone(overlay);
  delete historical.c1ThemeProvenance;
  historical.files = historical.files.filter(entry => !entry.c1ThemeAdded);
  for (const entry of historical.files.filter(candidate => 'c1ThemeSha256' in candidate)) {
    entry.combinedSha256 = entry.preC1ThemeCombinedSha256;
    delete entry.preC1ThemeCombinedSha256;
    delete entry.c1ThemeSha256;
    delete entry.c1ThemeSource;
    delete entry.c1ThemeNote;
  }
  assert.equal(digest(JSON.stringify(historical)), C1_PREDECESSOR_JSON, 'C1 unwind changed predecessor history');
  assert.equal(digest(`${JSON.stringify(historical, null, 2)}\n`), C1_PREDECESSOR_BYTES, 'C1 unwind changed predecessor bytes');
  return historical;
}

export function c1ThemeOutputSha256(overlay, file, historicalSha256) {
  const binding = C1_PREDECESSORS.find(([candidate]) => candidate === file);
  if (!binding) return historicalSha256;
  const [, predecessor, current] = binding;
  const entry = overlay.files.find(candidate => candidate.path === file);
  assert.ok(entry, `${file}: missing C1 successor`);
  assert.equal(entry.preC1ThemeCombinedSha256, predecessor, `${file}: C1 predecessor changed`);
  assert.equal(entry.c1ThemeSource, C1_SOURCE_AUTHORITY, `${file}: C1 source changed`);
  assert.match(entry.c1ThemeSource, /^[a-f0-9]{40}$/);
  assert.equal(entry.c1ThemeSha256, current, `${file}: C1 current binding changed`);
  assert.equal(entry.c1ThemeSha256, entry.combinedSha256);
  assert.equal(entry.c1ThemeNote, C1_NOTE);
  assert.ok(historicalSha256 === predecessor || historicalSha256 === entry.c1ThemeSha256,
    `${file}: unrelated digest cannot resolve through C1`);
  return entry.c1ThemeSha256;
}
