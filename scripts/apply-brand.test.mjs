import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/apply-brand.mjs');
const manifest = JSON.parse(readFileSync(path.join(root, 'branding/generated.json'), 'utf8'));
const controlledFiles = Object.keys(manifest.files);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const copyFixture = () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'openchamber-brand-'));
  for (const relative of ['branding/brand.json', 'branding/logo.svg', 'branding/generated.json', ...controlledFiles]) {
    const destination = path.join(fixture, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, relative), destination);
  }
  writeFileSync(path.join(fixture, 'uncontrolled.txt'), 'leave me alone\n');
  return fixture;
};

const runBrand = (fixture, ...args) => spawnSync(process.execPath, [script, '--root', fixture, ...args], {
  cwd: root,
  encoding: 'utf8',
});

const assertSucceeded = (result) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
};

const assertFailedWith = (result, pattern) => {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
};

test('brand check detects missing assets, manifest drift, and required text drift', () => {
  const fixture = copyFixture();
  try {
    assertSucceeded(runBrand(fixture, '--check'));

    const missingAsset = path.join(fixture, 'packages/web/public/pwa-512.png');
    rmSync(missingAsset);
    assertFailedWith(runBrand(fixture, '--check'), /pwa-512\.png/);
    assertSucceeded(runBrand(fixture));
    assert.equal(existsSync(missingAsset), true);
    assertSucceeded(runBrand(fixture, '--check'));

    const fixtureManifestPath = path.join(fixture, 'branding/generated.json');
    const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8'));
    fixtureManifest.files['unexpected-brand-output.txt'] = 'deadbeef';
    writeFileSync(fixtureManifestPath, `${JSON.stringify(fixtureManifest)}\n`);
    assertFailedWith(runBrand(fixture, '--check'), /manifest membership changed/);
    assertSucceeded(runBrand(fixture));

    const pwaManifestPath = path.join(fixture, 'packages/web/public/site.webmanifest');
    const pwaManifest = JSON.parse(readFileSync(pwaManifestPath, 'utf8'));
    delete pwaManifest.description;
    writeFileSync(pwaManifestPath, `${JSON.stringify(pwaManifest, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /PWA description/);
    copyFileSync(path.join(root, 'packages/web/public/site.webmanifest'), pwaManifestPath);
    assertSucceeded(runBrand(fixture));

    const readmePath = path.join(fixture, 'README.md');
    const readme = readFileSync(readmePath, 'utf8').replace(/^# .*$/m, '# drifted brand');
    writeFileSync(readmePath, readme);
    assertFailedWith(runBrand(fixture, '--check'), /README brand heading/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('alternate name, mark, and logo regenerate every controlled variant without non-brand edits', () => {
  const fixture = copyFixture();
  try {
    const pwaIconPath = path.join(fixture, 'packages/web/public/pwa-512.png');
    const originalPwaHash = sha256(pwaIconPath);
    const alternateLogo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <circle cx="41" cy="47" r="31" fill="#123456" stroke="#abcdef" stroke-width="7"/>\n  <path d="M24 58h34" fill="none" stroke="#abcdef" stroke-width="5"/>\n</svg>\n';
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Fixture Brand',
      mark: 'F!',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    writeFileSync(path.join(fixture, 'branding/logo.svg'), alternateLogo);

    assertSucceeded(runBrand(fixture));
    assertSucceeded(runBrand(fixture, '--check'));

    const generatedModule = readFileSync(path.join(fixture, 'packages/ui/src/lib/brand.generated.ts'), 'utf8');
    assert.match(generatedModule, /PRODUCT_NAME = "Fixture Brand"/);
    assert.match(generatedModule, /PRODUCT_MARK = "F!"/);

    const readme = readFileSync(path.join(fixture, 'README.md'), 'utf8');
    assert.match(readme, /^# <img .* alt="F!" \/> Fixture Brand$/m);
    assert.match(readme, /OpenChamber-\*\.AppImage/);
    assert.match(readme, /## Why OpenCode\?/);
    assert.match(readme, /not affiliated with the OpenCode team/);

    const installer = readFileSync(path.join(fixture, 'scripts/install.sh'), 'utf8');
    assert.match(installer, /F!  Fixture Brand/);
    assert.match(installer, /Make sure opencode is running: opencode serve/);

    assert.equal(readFileSync(path.join(fixture, 'packages/web/public/favicon.svg'), 'utf8'), alternateLogo);
    const monochrome = readFileSync(path.join(fixture, 'packages/vscode/assets/icon.svg'), 'utf8');
    assert.match(monochrome, /cx="41"/);
    assert.doesNotMatch(monochrome, /#123456|#abcdef/);
    assert.notEqual(sha256(pwaIconPath), originalPwaHash);
    assert.equal(readFileSync(path.join(fixture, 'uncontrolled.txt'), 'utf8'), 'leave me alone\n');

    const alternateManifest = JSON.parse(readFileSync(path.join(fixture, 'branding/generated.json'), 'utf8'));
    assert.equal('config' in alternateManifest, false);
    assert.deepEqual(Object.keys(alternateManifest.files).sort(), controlledFiles.sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('runtime branding is limited to owned templates and compatibility identities remain intact', () => {
  for (const relative of [
    'packages/ui/src/components/ui/toast.ts',
    'packages/ui/src/components/chat/ChatMessage.tsx',
    'packages/web/bin/cli-output.js',
    'packages/web/bin/cli.js',
    'packages/web/server/lib/openchamber-control/routes.js',
  ]) {
    assert.doesNotMatch(readFileSync(path.join(root, relative), 'utf8'), /\bbrandText\b/, relative);
  }

  const configUpdate = readFileSync(path.join(root, 'packages/ui/src/lib/configUpdate.ts'), 'utf8');
  assert.doesNotMatch(configUpdate, /brandText\(message/);
  const statusReport = readFileSync(path.join(root, 'packages/ui/src/lib/openCodeStatus.ts'), 'utf8');
  assert.doesNotMatch(statusReport, /setOpenCodeStatusText\(brandText/);

  const vscodeExtension = readFileSync(path.join(root, 'packages/vscode/src/extension.ts'), 'utf8');
  assert.match(vscodeExtension, /vscode\.l10n\.t\(brandText\(message\), \.\.\.args\)/);
  assert.doesNotMatch(vscodeExtension, /brandText\(vscode\.l10n\.t/);

  const oauthRoute = readFileSync(path.join(root, 'packages/web/server/lib/opencode/routes.js'), 'utf8');
  assert.match(oauthRoute, /Return to \$\{escapeHtml\(PRODUCT_NAME\)\}/);
  assert.match(oauthRoute, /openchamber:\/\/focus\/mcp-auth/);
  const tray = readFileSync(path.join(root, 'packages/ui/src/hooks/useTraySync.ts'), 'utf8');
  assert.match(tray, /LOCAL_INSTANCE_NAME = `Local \$\{PRODUCT_NAME\}`/);
  const server = readFileSync(path.join(root, 'packages/web/server/index.js'), 'utf8');
  assert.match(server, /Starting \$\{PRODUCT_NAME\} on port/);
  const passkeys = readFileSync(path.join(root, 'packages/web/server/lib/ui-auth/ui-passkeys.js'), 'utf8');
  assert.match(passkeys, /this \$\{PRODUCT_NAME\} instance/);
  const pwaRoute = readFileSync(path.join(root, 'packages/web/server/lib/opencode/pwa-manifest-routes.js'), 'utf8');
  assert.match(pwaRoute, /description: `\$\{PRODUCT_NAME\} AI coding assistant`/);

  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual({
    'dev:web:hmr': packageJson.scripts['dev:web:hmr'],
    'electron:dev': packageJson.scripts['electron:dev'],
    'electron:dev:bundled': packageJson.scripts['electron:dev:bundled'],
    'mobile:open:android': packageJson.scripts['mobile:open:android'],
    'vscode:dev': packageJson.scripts['vscode:dev'],
  }, {
    'dev:web:hmr': 'node ./scripts/dev-web-hmr.mjs',
    'electron:dev': 'node ./packages/electron/scripts/electron-dev.mjs',
    'electron:dev:bundled': 'OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1 node ./packages/electron/scripts/electron-dev.mjs',
    'mobile:open:android': 'bun run --cwd packages/mobile open:android',
    'vscode:dev': 'node ./scripts/dev-vscode.mjs',
  });

  const pbxProject = readFileSync(path.join(root, 'packages/mobile/ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  assert.doesNotMatch(pbxProject, /AppIcon\.icon/);
  const electronPackage = JSON.parse(readFileSync(path.join(root, 'packages/electron/package.json'), 'utf8'));
  assert.equal(electronPackage.build.mac.artifactName, 'OpenChamber-${version}-mac-${arch}.${ext}');

  const staleScreenshotName = ['extension', 'jpg'].join('.');
  assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8').includes(staleScreenshotName), false);
  assert.equal(readFileSync(path.join(root, 'packages/vscode/README.md'), 'utf8').includes(staleScreenshotName), false);
  assert.equal(existsSync(path.join(root, 'packages/vscode', staleScreenshotName)), false);
  assert.equal(existsSync(path.join(root, 'packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.xml')), false);
  assert.equal(existsSync(path.join(root, 'packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.png')), true);
});
