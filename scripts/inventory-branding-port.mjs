// Rebuild review evidence from committed donor objects and the current port.
// Fetch the documented donor commits before running; ordinary CI needs no donor checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const resolve = (ref) => git('rev-parse', ref).trim();
const stock = resolve('2dfd1190');
const donor = resolve('d6ef11b4');
const merges = ['af19b69b', 'e76c9aef'].map(resolve);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const notes = {
  '.github/workflows/oc-review.yml': 'Keep stock workflow/job identities; extend genuine source checks with brand:check/test:brand. No protected-branch/default/Mergify policy is changed.',
  '.github/workflows/docs-source.yml': 'Retain branded docs artifact coverage; install the existing YAML parser dependency before checking the copied docs. Release/archive/dispatch identities remain unchanged.',
  'README.md': 'Preserve upstream gratitude, credits, links and technical installation examples; accurately distinguish upstream releases and this fork.',
  'package.json': 'Keep stock 1.22.2, author and dependencies; retain donor branding generation/check/build/documentation integration.',
  'packages/electron/package.json': 'Brand product/package presentation only; preserve upstream author, app ID, executable IDs and update/release identities.',
  'packages/electron/resources/icons/AppIcon.icon/Assets/app-icon-glyph-dark 4.png': 'Donor retirement retained: replaced by generated light/dark/tray/app PNG variants from the configured SVG; see generated.json.',
  'packages/electron/resources/icons/AppIcon.icon/Assets/app-icon-glyph-light 2.png': 'Donor retirement retained: replaced by generated light/dark/tray/app PNG variants from the configured SVG; see generated.json.',
  'packages/electron/resources/icons/AppIcon.icon/icon.json': 'Donor retirement retained: electron-builder mac/win/linux icon fields now consume generated resources/icons/app-icon.png, not Icon Composer metadata.',
  'packages/electron/resources/icons/Assets.car': 'Donor retirement retained: generated PNG is the native packager input; packaged OS icon conversion is not a verified native installation claim.',
  'packages/electron/resources/icons/icon.icns': 'Donor retirement retained: electron-builder mac.icon consumes generated app-icon.png; no stale stock ICNS artwork.',
  'packages/electron/resources/icons/icon.ico': 'Donor retirement retained: electron-builder win.icon consumes generated app-icon.png; no stale stock ICO artwork.',
  'packages/electron/scripts/after-pack.cjs': 'Donor retirement retained: no stale Assets.car after-pack injection; packaging uses the generated PNG icon input.',
  'packages/electron/scripts/generate-macos-icon-assets.cjs': 'Donor retirement retained: the shared generator owns the PNG icon input instead of a separate Icon Composer script.',
  'packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.xml': 'Donor retirement retained: all generated density-specific drawable PNGs keep the same ic_stat_notify resource identity; see asset-parity.json.',
  'packages/vscode/extension.jpg': 'Donor retirement retained: packages/vscode/package.json icon points to generated assets/app-icon.png instead of stale stock JPEG.',
  'packages/ui/src/components/ui/toast.ts': 'Stock generic formatter retained: caller-owned templates are branded before interpolation. Never rewrite raw error/provider/user content.',
  'packages/ui/src/lib/shortcuts.test.ts': 'Stock test retained; donor-only shortcut fixture drift is unrelated to branding and no product label is lost.',
  'packages/ui/src/sync/session-actions.test.ts': 'Absent-owner fixture reconciliation: donor deletion-confirmation recovery assertions at sweep lines 719 and 751 have no stock test/behavior owner; see absent-owners.md.',
  'packages/vscode/src/bridge-session-runtime.ts': 'Absent donor behavior not imported. API-unavailable label mapped to stock localfs/git proxy owners; deletion confirmation has no stock owner. See absent-owners.md.',
  'packages/vscode/src/bridge-session-runtime.test.ts': 'Absent donor bridge test not recreated; stock proxy response coverage and absent-owner parity test replace applicable assertion. See absent-owners.md.',
  'packages/web/server/lib/openchamber-sessions/routes.js': 'Retain stock accepted-prompt error branding; do not import absent deletion-confirmation flow. See absent-owners.md.',
  'packages/web/server/lib/session-goal/runtime.js': 'Retain stock request-failure branding; null/JSON/error/control flow unchanged. Three absent paginated-history labels are individually reconciled in absent-owners.md.',
  'packages/web/bin/cli-output.js': 'Generic output adapter stays byte-identical to stock; brand only owned caller templates. Do not rewrite arbitrary payloads.',
  'packages/web/bin/cli.js': 'Stock dispatch and raw diagnostic serialization retained; owned labels live in caller command/helper modules. No literal product presentation is omitted.',
  'packages/web/bin/cli.test.js': 'Preserve all CLI branding checks; adapt donor normalization expectation to unchanged stock Error serialization, not a runtime behavior patch.',
  'packages/vscode/src/extension.ts': 'Use stock manager output-channel owner in opencode.ts; keep newer localization/inline-comment APIs and technical diagnostics.',
  'packages/vscode/src/webviewHtml.ts': 'Keep current French/Turkish localization structure and real opencode commands; brand owned titles only before escaping/interpolation.',
  'packages/ui/src/lib/theme/themes/index.ts': 'Brand theme names/descriptions, not theme author attribution.',
};
const specialized = (file, header) => {
  if (file === 'packages/web/server/lib/session-goal/runtime.js') {
    return header.includes('-338,') ? 'Equivalent stock request-failure label: Engine; stock response.json().catch(() => null) preserved.'
      : 'Donor paginated-history owner absent; no new exception/pagination. See the exact labeled row in absent-owners.md.';
  }
  if (file === 'packages/web/server/lib/openchamber-sessions/routes.js') {
    return header.includes('-508,') ? 'Deletion confirmation owner absent; no new compensation/deletion behavior.'
      : 'Owned accepted-prompt error label ported at existing stock owner.';
  }
  return notes[file] ?? null;
};
const files = new Map();
for (const commit of merges) {
  for (const file of git('diff', '--name-only', `${commit}^1`, commit).trim().split('\n')) {
    const entry = files.get(file) ?? { path: file, sources: [] };
    const patch = git('diff', '--no-ext-diff', '--unified=3', `${commit}^1`, commit, '--', file);
    entry.sources.push({ commit, patchSha256: sha256(patch), hunks: [...patch.matchAll(/^@@.*$/gm)].map(([header]) => ({
      header, resolution: specialized(file, header) ?? 'Preserved presentation edit; adapted to current stock owner where source drift exists. See file disposition and surface policy.',
    })) });
    files.set(file, entry);
  }
}
const changed = new Set(git('diff', stock, '--name-only').trim().split('\n'));
for (const entry of files.values()) {
  const absolute = path.join(root, entry.path);
  const exists = existsSync(absolute);
  const object = exists ? git('hash-object', '--', entry.path).trim() : null;
  const tree = git('ls-tree', donor, '--', entry.path).trim();
  const donorObject = tree ? tree.split(/\s+/)[2] : null;
  entry.disposition = !exists ? (donorObject ? 'absent-owner' : 'donor-retirement') : !changed.has(entry.path) ? 'stock-retained' : object === donorObject ? 'donor-identical' : 'stock-adapted';
  entry.outputSha256 = exists ? sha256(readFileSync(absolute)) : null;
  entry.note = notes[entry.path] ?? (entry.path.startsWith('packages/docs/')
    ? 'Current upstream documentation retained and branded using attribution-preserving prose boundary; technical code/examples and OpenCode identity preserved.'
    : entry.path.endsWith('.png') || entry.path.endsWith('.svg')
      ? 'Configured donor mark/art retained or regenerated; asset-parity.json and generated.json enumerate variants/dimensions/digests.'
      : 'Full donor presentation coverage retained with current stock imports/APIs/behavior and compatibility identities.');
}
const brandedDonorPaths = git('grep', '-l', '-E', 'Smarty Code|smarty-code|brand[.]generated', donor, '--', ':(exclude)bun.lock')
  .trim().split('\n').map((value) => value.slice(value.indexOf(':') + 1));
const outside = brandedDonorPaths.filter((file) => !files.has(file));
if (outside.length) throw new Error(`Unreconciled branded donor files outside both merges: ${outside.join(', ')}`);
const output = {
  generatedBy: 'node scripts/inventory-branding-port.mjs', stock, donor, merges,
  note: 'Per-source-hunk ledger, not a runtime proof. See README.md, absent-owners.md and integration docs/branding-proof.md for policy, adaptations and measured acceptance.',
  distinctDonorFiles: files.size, brandedDonorFilesOutsideBothMerges: outside,
  additionalStockPaths: [...changed].filter((file) => !files.has(file) && !file.startsWith('branding/') && file !== 'scripts/inventory-branding-port.mjs').sort(),
  files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(path.join(root, 'branding/coverage.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Inventoried ${files.size} donor files across ${merges.length} commits; no extra branded donor paths.`);
