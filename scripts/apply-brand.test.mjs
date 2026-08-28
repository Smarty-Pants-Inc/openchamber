import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/apply-brand.mjs');
const brandConfig = JSON.parse(readFileSync(path.join(root, 'branding/brand.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'branding/generated.json'), 'utf8'));
const EXPECTED_GENERATED_MODULE_COUNT = 5;
const EXPECTED_PATCHED_TEXT_COUNT = 25;
const EXPECTED_SVG_COUNT = 12;
const EXPECTED_PNG_COUNT = 98;
const EXPECTED_CONTROLLED_FILE_COUNT = EXPECTED_GENERATED_MODULE_COUNT
  + EXPECTED_PATCHED_TEXT_COUNT
  + EXPECTED_SVG_COUNT
  + EXPECTED_PNG_COUNT;
assert.equal(EXPECTED_CONTROLLED_FILE_COUNT, 140);
const controlledFiles = Object.keys(manifest.files);
assert.equal(controlledFiles.length, EXPECTED_CONTROLLED_FILE_COUNT);
assert.equal(new Set(controlledFiles).size, EXPECTED_CONTROLLED_FILE_COUNT);
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

test('canonical generated brandText follows configured presentation aliases', async () => {
  assert.equal(brandConfig.presentationAliases.includes('OpenCode'), true);
  const generatedBrandModule = await import(`${pathToFileURL(path.join(root, 'packages/web/brand.generated.js')).href}?canonical=${Date.now()}`);
  for (const alias of brandConfig.presentationAliases) {
    assert.equal(generatedBrandModule.brandText(alias), brandConfig.name);
  }
  assert.equal(generatedBrandModule.brandProductText("qu’OpenChamber d’OpenChamber l’OpenChamber"), 'que smarty-code de smarty-code le smarty-code');
  assert.equal(generatedBrandModule.brandProductText('OpenChamber OpenCode'), `${brandConfig.name} OpenCode`);
});
test('runtime-facing product labels use generated branding', () => {
  const autocomplete = readFileSync(path.join(root, 'packages/ui/src/components/chat/CommandAutocomplete.tsx'), 'utf8');
  assert.match(autocomplete, /\{PRODUCT_NAME\}/);
  assert.doesNotMatch(autocomplete, />\s*OpenChamber\s*</);

  for (const relativePath of ['packages/ui/src/lib/worktreeSessionCreator.ts', 'packages/ui/src/sync/session-ui-store.ts']) {
    const source = readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(source, /Project is not registered in \$\{PRODUCT_NAME\}/);
  }
});

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

test('alternate name, mark, aliases, and logo regenerate every controlled variant without non-brand edits', async () => {
  const fixture = copyFixture();
  try {
    const pwaIconPath = path.join(fixture, 'packages/web/public/pwa-512.png');
    const originalPwaHash = sha256(pwaIconPath);
    const alternateLogo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <circle cx="41" cy="47" r="31" fill="#123456" stroke="#abcdef" stroke-width="7"/>\n  <path d="M24 58h34" fill="none" stroke="#abcdef" stroke-width="5"/>\n</svg>\n';
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Fixture Brand',
      mark: 'F!',
      presentationAliases: ['Legacy Product', '@old', 'C++', 'smarty-code'],
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    writeFileSync(path.join(fixture, 'branding/logo.svg'), alternateLogo);

    assertSucceeded(runBrand(fixture));
    assertSucceeded(runBrand(fixture, '--check'));

    const generatedModulePath = path.join(fixture, 'packages/ui/src/lib/brand.generated.ts');
    const generatedModule = readFileSync(generatedModulePath, 'utf8');
    assert.match(generatedModule, /PRODUCT_NAME = "Fixture Brand"/);
    assert.match(generatedModule, /PRODUCT_MARK = "F!"/);
    assert.match(generatedModule, /\(\?<!\\w\)/);
    assert.match(generatedModule, /Legacy Product/);
    assert.equal(generatedModule.includes(String.raw`C\+\+`), true);
    assert.match(generatedModule, /OpenChamber/);
    assert.doesNotMatch(generatedModule, /OpenCode/);
    const generatedBrandModule = await import(`${pathToFileURL(path.join(fixture, 'packages/web/brand.generated.js')).href}?fixture=${Date.now()}`);
    assert.equal(generatedBrandModule.brandText('Legacy Product @old C++ smarty-code OpenChamber OpenCode'), 'Fixture Brand Fixture Brand Fixture Brand Fixture Brand Fixture Brand OpenCode');

    const readme = readFileSync(path.join(fixture, 'README.md'), 'utf8');
    assert.match(readme, /^# <img .* alt="F!" \/> Fixture Brand$/m);
    assert.match(readme, /OpenChamber-\*\.AppImage/);
    assert.match(readme, /## Why OpenCode\?/);
    assert.match(readme, /not affiliated with the OpenCode team/);

    const installer = readFileSync(path.join(fixture, 'scripts/install.sh'), 'utf8');
    assert.match(installer, /F!  Fixture Brand/);
    assert.match(installer, /Make sure opencode is running: opencode serve/);

    assert.equal(readFileSync(path.join(fixture, 'packages/web/public/favicon.svg'), 'utf8'), alternateLogo);
    const activityBarIcon = readFileSync(path.join(fixture, 'packages/vscode/assets/icon.svg'), 'utf8');
    assert.match(activityBarIcon, /cx="41"/);
    assert.match(activityBarIcon, /(?:fill|stroke)="currentColor"/);
    assert.doesNotMatch(activityBarIcon, /#123456|#abcdef|#000|#fff/);
    const titlebarIcon = readFileSync(path.join(fixture, 'packages/vscode/assets/icon-titlebar.svg'), 'utf8');
    assert.match(titlebarIcon, /(?:fill|stroke)="#fff"/);
    assert.doesNotMatch(titlebarIcon, /currentColor|#123456|#abcdef/);
    assert.notEqual(sha256(pwaIconPath), originalPwaHash);
    const pbxproj = readFileSync(path.join(fixture, 'packages/mobile/ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    assert.equal((pbxproj.match(/INFOPLIST_KEY_CFBundleDisplayName = "Fixture Brand";/g) ?? []).length, 2);
    assert.equal(readFileSync(path.join(fixture, 'uncontrolled.txt'), 'utf8'), 'leave me alone\n');

    const alternateManifest = JSON.parse(readFileSync(path.join(fixture, 'branding/generated.json'), 'utf8'));
    assert.equal('config' in alternateManifest, false);
    assert.equal(Object.keys(alternateManifest.files).length, EXPECTED_CONTROLLED_FILE_COUNT);
    assert.deepEqual(Object.keys(alternateManifest.files).sort(), controlledFiles.sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('quoted product names produce a TypeScript-safe Capacitor appName', async () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: `Fixture's "Brand" & $& <tag>`,
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);

    assertSucceeded(runBrand(fixture));
    assertSucceeded(runBrand(fixture));
    assertSucceeded(runBrand(fixture, '--check'));
    const docsFixtureDir = path.join(fixture, 'packages/docs/content');
    mkdirSync(docsFixtureDir, { recursive: true });
    writeFileSync(path.join(docsFixtureDir, 'hostile.mdx'), '# OpenChamber\n\n```json\n{"description":"OpenChamber"}\n```\n');
    assertSucceeded(runBrand(fixture, '--docs', 'packages/docs'));
    const hostileDocs = readFileSync(path.join(docsFixtureDir, 'hostile.mdx'), 'utf8');
    assert.equal(hostileDocs.includes('Fixture&#39;s &quot;Brand&quot; &amp; $&amp; &lt;tag&gt;'), true);

    const capacitorConfig = readFileSync(path.join(fixture, 'packages/mobile/capacitor.config.ts'), 'utf8');
    assert.match(capacitorConfig, /appName: "Fixture's \\"Brand\\" & \$& <tag>"/);
    const diagnostics = ts.transpileModule(capacitorConfig, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
      fileName: 'capacitor.config.ts',
      reportDiagnostics: true,
    }).diagnostics ?? [];
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.messageText), []);

    const androidStrings = readFileSync(path.join(fixture, 'packages/mobile/android/app/src/main/res/values/strings.xml'), 'utf8');
    assert.match(androidStrings, /<string name="app_name">Fixture\\'s \\"Brand\\" &amp; \$&amp; &lt;tag&gt;<\/string>/);
    const infoPlist = readFileSync(path.join(fixture, 'packages/mobile/ios/App/App/Info.plist'), 'utf8');
    assert.match(infoPlist, /<key>CFBundleDisplayName<\/key>\s*<string>Fixture's "Brand" &amp; \$&amp; &lt;tag&gt;<\/string>/);
    const pbxproj = readFileSync(path.join(fixture, 'packages/mobile/ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    assert.equal((pbxproj.match(/INFOPLIST_KEY_CFBundleDisplayName = "Fixture's \\"Brand\\" & \$& <tag>";/g) ?? []).length, 2);
    const localeBundle = JSON.parse(readFileSync(path.join(fixture, 'packages/vscode/l10n/bundle.l10n.json'), 'utf8'));
    assert.equal(localeBundle[`Fixture's "Brand" & $& <tag>: Failed to open sidebar - {0}`], `Fixture's "Brand" & $& <tag>: Failed to open sidebar - {0}`);
    const vscodeWebview = readFileSync(path.join(fixture, 'packages/vscode/webview/index.html'), 'utf8');
    assert.match(vscodeWebview, /<title>Fixture's "Brand" &amp; \$&amp; &lt;tag&gt;<\/title>/);
    const readme = readFileSync(path.join(fixture, 'README.md'), 'utf8');
    assert.match(readme, /^# <img .* alt="🤓" \/> Fixture&#39;s &quot;Brand&quot; &amp; \$&amp; &lt;tag&gt;$/m);
    const installer = readFileSync(path.join(fixture, 'scripts/install.sh'), 'utf8');
    assert.match(installer, /Installing Fixture's \\"Brand\\" & \\\$& <tag>\.\.\./);
    assert.equal(spawnSync('bash', ['-n', path.join(fixture, 'scripts/install.sh')], { encoding: 'utf8' }).status, 0);
    const generatedBrandModule = await import(`${pathToFileURL(path.join(fixture, 'packages/web/brand.generated.js')).href}?quoted=${Date.now()}`);
    assert.equal(generatedBrandModule.brandText('OpenChamber'), `Fixture's "Brand" & $& <tag>`);
    const cliFixtureDir = path.join(fixture, 'packages/web/bin/lib');
    mkdirSync(cliFixtureDir, { recursive: true });
    for (const relative of ['packages/web/bin/lib/cli-args.js', 'packages/web/bin/lib/cli-errors.js']) {
      const destination = path.join(fixture, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, relative), destination);
    }
    const { generateCompletionScript } = await import(`${pathToFileURL(path.join(cliFixtureDir, 'cli-args.js')).href}?quoted-completion=${Date.now()}`);
    const completion = generateCompletionScript('zsh');
    assert.equal(completion.includes("'logs:Tail Fixture'\\''s \"Brand\" & $& <tag> logs'"), true);
    const zshCheck = spawnSync('zsh', ['-n'], { input: completion, encoding: 'utf8' });
    if (zshCheck.error?.code !== 'ENOENT') assert.equal(zshCheck.status, 0, `${zshCheck.stdout}\n${zshCheck.stderr}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('rejects branding configurations without presentation aliases', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      presentationAliases: [],
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /presentationAliases must contain at least one non-empty string/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('rejects control characters in configured branding values', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Fixture\nBrand',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /name must not contain control characters/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('runtime branding is limited to owned templates and compatibility identities remain intact', () => {
  const viteConfig = readFileSync(path.join(root, 'packages/web/vite.config.ts'), 'utf8');
  const webIndex = readFileSync(path.join(root, 'packages/web/index.html'), 'utf8');
  const mobileIndex = readFileSync(path.join(root, 'packages/web/mobile.html'), 'utf8');
  const miniChatIndex = readFileSync(path.join(root, 'packages/web/mini-chat.html'), 'utf8');
  assert.match(viteConfig, /replaceAll\('__PRODUCT_NAME_JSON__', \(\) => productNameJson\)/);
  assert.match(viteConfig, /replaceAll\('__PRODUCT_NAME_HTML__', \(\) => productNameHtml\)/);
  assert.match(viteConfig, /escapeJsonForHtmlScript/);
  assert.match(webIndex, /const defaultAppName = __PRODUCT_NAME_JSON__ \+ ' - AI Coding Assistant';/);
  assert.match(webIndex, /content="__PRODUCT_NAME_HTML__"/);
  assert.match(webIndex, /__PRODUCT_MARK_HTML__/);
  assert.match(mobileIndex, /<title>__PRODUCT_NAME_HTML__ Mobile<\/title>/);
  assert.match(miniChatIndex, /<title>__PRODUCT_NAME_HTML__ Mini Chat<\/title>/);
  const electronMain = readFileSync(path.join(root, 'packages/electron/main.mjs'), 'utf8');
  const staticRoutes = readFileSync(path.join(root, 'packages/web/server/lib/opencode/static-routes-runtime.js'), 'utf8');
  const updateRoutes = readFileSync(path.join(root, 'packages/web/server/lib/opencode/openchamber-routes.js'), 'utf8');
  assert.match(electronMain, /aria-label="\$\{escapeHtml\(PRODUCT_NAME\)\} loading icon/);
  assert.match(staticRoutes, /aria-label="\$\{escapeHtml\(PRODUCT_NAME\)\} logo/);
  assert.match(updateRoutes, /quotePosix\(`Update successful, restarting \$\{PRODUCT_NAME\}/);
  assert.match(updateRoutes, /quoteCmd\(`Update successful, restarting \$\{PRODUCT_NAME\}/);
  const englishBundle = JSON.parse(readFileSync(path.join(root, 'packages/vscode/l10n/bundle.l10n.json'), 'utf8'));
  const frenchBundle = JSON.parse(readFileSync(path.join(root, 'packages/vscode/l10n/bundle.l10n.fr.json'), 'utf8'));
  assert.equal(englishBundle['smarty-code: No folder is open. Open a folder to start a new session.'], 'smarty-code: No folder is open. Open a folder to start a new session.');
  assert.equal(frenchBundle['smarty-code: No folder is open. Open a folder to start a new session.'], 'smarty-code : aucun dossier n’est ouvert. Ouvrez un dossier pour démarrer une nouvelle session.');
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
  const lifecycleSource = readFileSync(path.join(root, 'packages/web/server/lib/opencode/lifecycle.js'), 'utf8');
  const startupSource = readFileSync(path.join(root, 'packages/web/bin/lib/cli-startup.js'), 'utf8');
  assert.match(startupSource, /Description=\$\{systemdDescription\(PRODUCT_NAME\)\} web server/);
  assert.match(lifecycleSource, /Launching OpenCode through WSL/);
  assert.match(lifecycleSource, /external OpenCode server/);
  assert.match(pwaRoute, /description: `\$\{PRODUCT_NAME\} web interface companion for OpenCode AI coding agent`/);
  assert.match(webIndex, /description: __PRODUCT_NAME_JSON__ \+ ' web interface companion for OpenCode AI coding agent'/);

  const repairedPresentationFiles = [
    'packages/web/bin/lib/commands-logs.js',
    'packages/web/bin/lib/commands-serve.js',
    'packages/web/bin/lib/commands-lifecycle.js',
    'packages/web/bin/lib/commands-startup.js',
    'packages/web/bin/lib/commands-status.js',
    'packages/web/bin/lib/commands-tunnel.js',
    'packages/web/bin/lib/commands-update.js',
    'packages/web/bin/lib/cli-api-target.js',
    'packages/web/bin/lib/cli-network.js',
    'packages/web/bin/lib/cli-ports.js',
    'packages/web/server/lib/opencode/env-runtime.js',
    'packages/web/server/lib/opencode/lifecycle.js',
    'packages/web/server/lib/opencode/proxy.js',
    'packages/vscode/src/bridge-config-runtime.ts',
    'packages/vscode/src/opencode.ts',
  ];
  for (const relative of repairedPresentationFiles) {
    assert.match(readFileSync(path.join(root, relative), 'utf8'), /\bPRODUCT_NAME\b/, relative);
  }

  const forbiddenOwnedTemplates = {
    'packages/web/bin/lib/commands-logs.js': ['No running OpenChamber', 'OpenChamber Logs'],
    'packages/web/bin/lib/commands-serve.js': ['OpenChamber serve', 'OpenChamber Desktop app', 'OpenChamber is already running', 'Starting OpenChamber', 'OpenChamber daemon', 'Failed to start OpenChamber', 'OpenChamber Started'],
    'packages/web/bin/lib/commands-lifecycle.js': ['OpenChamber Stop', 'OpenChamber Restart', 'OpenChamber Desktop', 'OpenChamber instance', 'Stopping OpenChamber', 'Stopped OpenChamber'],
    'packages/web/bin/lib/commands-startup.js': ['OpenChamber Startup'],
    'packages/web/bin/lib/commands-status.js': ['OpenChamber Status'],
    'packages/web/bin/lib/commands-tunnel.js': ['OpenChamber Desktop app', 'OpenChamber CLI', 'OpenChamber instance', 'Select OpenChamber', 'Waiting for OpenChamber'],
    'packages/web/bin/lib/commands-update.js': ['OpenChamber Update'],
    'packages/web/bin/lib/cli-api-target.js': ['Multiple OpenChamber instances', 'No running OpenChamber server'],
    'packages/web/bin/lib/cli-network.js': ['OpenChamber UI'],
    'packages/web/bin/lib/cli-ports.js': ['OpenChamber Desktop', 'OpenChamber instance'],
    'packages/web/server/lib/opencode/env-runtime.js': ['Configured OpenCode binary', 'OpenChamber could not resolve', 'supported by OpenChamber desktop'],
    'packages/web/server/lib/opencode/lifecycle.js': ['Failed to start OpenCode', 'Restarting OpenCode', 'OpenCode process exited before serving'],
    'packages/vscode/src/bridge-config-runtime.ts': ['Restart OpenCode to apply'],
    'packages/vscode/src/opencode.ts': ['OpenCode CLI not found', 'Failed to start OpenCode'],
    'packages/vscode/l10n/bundle.l10n.json': ['OpenCode CLI not found', 'Failed to start OpenCode'],
    'packages/vscode/l10n/bundle.l10n.fr.json': ['OpenCode CLI not found', 'Failed to start OpenCode'],
  };
  for (const [relative, fragments] of Object.entries(forbiddenOwnedTemplates)) {
    const contents = readFileSync(path.join(root, relative), 'utf8');
    for (const fragment of fragments) {
      assert.equal(contents.includes(fragment), false, `${relative}: ${fragment}`);
    }
  }

  const cliServe = readFileSync(path.join(root, 'packages/web/bin/lib/commands-serve.js'), 'utf8');
  assert.match(cliServe, /`openchamber status`|`openchamber stop --port/);
  const cliTunnel = readFileSync(path.join(root, 'packages/web/bin/lib/commands-tunnel.js'), 'utf8');
  assert.match(cliTunnel, /`openchamber serve/);
  const envRuntime = readFileSync(path.join(root, 'packages/web/server/lib/opencode/env-runtime.js'), 'utf8');
  assert.match(envRuntime, /OPENCODE_BINARY_INVALID/);
  assert.equal(envRuntime.includes('OpenCode(?: Dev| Beta)?\\.app'), true);
  assert.equal(envRuntime.includes('programs${path.sep}opencode${path.sep}opencode.exe'), true);
  const lifecycle = readFileSync(path.join(root, 'packages/web/server/lib/opencode/lifecycle.js'), 'utf8');
  assert.match(lifecycle, /OPENCODE_BINARY_INVALID/);
  const vscodeManager = readFileSync(path.join(root, 'packages/vscode/src/opencode.ts'), 'utf8');
  assert.match(vscodeManager, /vscode\.l10n\.t\(brandText\(message\), \.\.\.args\)/);
  assert.match(vscodeManager, /t\('Failed to start \{0\}: \{1\}', PRODUCT_NAME, message\)/);
  const bridgeConfig = readFileSync(path.join(root, 'packages/vscode/src/bridge-config-runtime.ts'), 'utf8');
  assert.match(bridgeConfig, /Restart \$\{PRODUCT_NAME\} to apply/);

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
