import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import { parseDocument } from 'yaml';

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
const findMdxFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? findMdxFiles(file) : entry.name.endsWith('.mdx') ? [file] : [];
});


test('canonical generated brandText follows configured presentation aliases', async () => {
  assert.equal(brandConfig.presentationAliases.includes('OpenCode'), true);
  const generatedBrandModule = await import(`${pathToFileURL(path.join(root, 'packages/web/brand.generated.js')).href}?canonical=${Date.now()}`);
  for (const alias of brandConfig.presentationAliases) {
    assert.equal(generatedBrandModule.brandText(alias), brandConfig.name);
  }
  assert.equal(generatedBrandModule.brandProductText("qu’OpenChamber d’OpenChamber l’OpenChamber"), `que ${brandConfig.name} de ${brandConfig.name} le ${brandConfig.name}`);
  assert.equal(generatedBrandModule.brandProductText("d’OpenChamber"), `de ${brandConfig.name}`);
  assert.equal(generatedBrandModule.brandProductText('OpenChamber OpenCode'), `${brandConfig.name} OpenCode`);
  assert.equal(generatedBrandModule.brandProductText("xQu'OpenChamber"), "xQu'OpenChamber");
});
test('branded MDX descriptions stay parseable without column-zero continuations', () => {
  for (const file of findMdxFiles(path.join(root, 'packages/docs/content/docs'))) {
    const relative = path.relative(root, file);
    const source = readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
    assert.ok(frontmatter, `${relative}: missing frontmatter`);
    const document = parseDocument(frontmatter[1]);
    assert.equal(document.errors.length, 0, `${relative}: ${document.errors.map(({ message }) => message).join('\n')}`);
    const description = document.get('description');
    if (!String(description).includes(brandConfig.name)) continue;
    const descriptionNode = document.get('description', true);
    assert.ok(descriptionNode?.range, `${relative}: description has no source range`);
    assert.doesNotMatch(frontmatter[1].slice(descriptionNode.range[0], descriptionNode.range[1]), /\r?\n\S/, `${relative}: branded description continuation starts at column zero`);
  }
});
test('rejects product names that contain presentation aliases', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'My OpenChamber',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /name must not contain presentation alias OpenChamber/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
    assertSucceeded(runBrand(fixture));
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
      presentationAliases: ['Legacy Product', '@old', 'C++', 'smarty-code', 'Smarty Code'],
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    writeFileSync(path.join(fixture, 'branding/logo.svg'), alternateLogo);

    assertSucceeded(runBrand(fixture));
    assertSucceeded(runBrand(fixture, '--check'));

    const generatedModulePath = path.join(fixture, 'packages/ui/src/lib/brand.generated.ts');
    const generatedModule = readFileSync(generatedModulePath, 'utf8');
    assert.match(generatedModule, /PRODUCT_NAME = "Fixture Brand"/);
    assert.match(generatedModule, /PRODUCT_MARK = "F!"/);
    assert.equal(generatedModule.includes('(?<!\\w)'), false);
    assert.match(generatedModule, /const replaceAliases/);
    assert.match(generatedModule, /Legacy Product/);
    assert.equal(generatedModule.includes(String.raw`C\+\+`), true);
    assert.match(generatedModule, /OpenChamber/);
    assert.doesNotMatch(generatedModule, /OpenCode/);
    const generatedBrandModule = await import(`${pathToFileURL(path.join(fixture, 'packages/web/brand.generated.js')).href}?fixture=${Date.now()}`);
    assert.equal(generatedBrandModule.brandText('Legacy Product @old C++ smarty-code OpenChamber OpenCode'), 'Fixture Brand Fixture Brand Fixture Brand Fixture Brand Fixture Brand OpenCode');
    assert.equal(generatedBrandModule.brandText('@old!@old'), 'Fixture Brand!Fixture Brand');
    const localeBundle = JSON.parse(readFileSync(path.join(fixture, 'packages/vscode/l10n/bundle.l10n.json'), 'utf8'));
    assert.equal(localeBundle['Fixture Brand: Failed to open sidebar - {0}'], 'Fixture Brand: Failed to open sidebar - {0}');

    const readme = readFileSync(path.join(fixture, 'README.md'), 'utf8');
    assert.match(readme, /^# <img .* alt="F!" \/> Fixture Brand$/m);
    assert.match(readme, /OpenChamber-\*\.AppImage/);
    assert.match(readme, /## Why OpenCode\?/);
    assert.match(readme, /not affiliated with the OpenCode team/);

    const installer = readFileSync(path.join(fixture, 'scripts/install.sh'), 'utf8');
    assert.match(installer, /F!  Fixture Brand/);
    const controlSwift = readFileSync(path.join(fixture, 'packages/mobile/ios/App/OpenChamberWidget/OpenChamberControl.swift'), 'utf8');
    assert.match(controlSwift, /\.description\("Start a new Fixture Brand session\."\)/);
    assert.match(installer, /printf '%s\\n' '  F!  Fixture Brand'/);
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
    const brandedDescription = `Let an agent manage ${alternateConfig.name} sessions, worktrees, and scheduled tasks from chat.`;
    writeFileSync(path.join(docsFixtureDir, 'hostile.mdx'), '---\ndescription: Let an agent manage OpenChamber sessions, worktrees, and scheduled tasks from chat.\n---\n# OpenChamber\n\n```json\n{"description":"OpenChamber"}\n```\n\n```yaml\ndescription: OpenChamber\n```\n');
    assertSucceeded(runBrand(fixture, '--docs', 'packages/docs'));
    const hostileDocs = readFileSync(path.join(docsFixtureDir, 'hostile.mdx'), 'utf8');
    assert.equal(hostileDocs.includes('# Fixture&#39;s &quot;Brand&quot; &amp; $&amp; &lt;tag&gt;'), true);
    const frontmatter = hostileDocs.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter);
    const document = parseDocument(frontmatter[1]);
    assert.equal(document.errors.length, 0);
    assert.equal(document.toJS().description, brandedDescription);
    const description = document.get('description', true);
    assert.ok(description?.range);
    assert.doesNotMatch(frontmatter[1].slice(description.range[0], description.range[1]), /\r?\n\S/);
    const jsonFence = hostileDocs.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(jsonFence);
    assert.equal(JSON.parse(jsonFence[1]).description, alternateConfig.name);
    const yamlFence = hostileDocs.match(/```yaml\n([\s\S]*?)\n```/);
    assert.ok(yamlFence);
    assert.equal(parseDocument(yamlFence[1]).toJS().description, alternateConfig.name);

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
    assert.match(installer, /printf '%s\\n' /);
    assert.doesNotMatch(installer, /printf '  .*Fixture/);
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

test('preserves JavaScript branding data that resembles type annotations', async () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Acme (template: string)',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertSucceeded(runBrand(fixture));
    const generatedBrandModule = await import(`${pathToFileURL(path.join(fixture, 'packages/web/brand.generated.js')).href}?annotation=${Date.now()}`);
    assert.equal(generatedBrandModule.brandText('OpenChamber'), alternateConfig.name);
    assert.equal(generatedBrandModule.PRODUCT_NAME, alternateConfig.name);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('escapes Markdown metacharacters in branded prose', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Acme [portal](https://example.invalid)',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertSucceeded(runBrand(fixture));
    const docsFixtureDir = path.join(fixture, 'packages/docs/content');
    mkdirSync(docsFixtureDir, { recursive: true });
    const docsPath = path.join(docsFixtureDir, 'markdown-meta.md');
    writeFileSync(docsPath, '# OpenChamber\n');
    assertSucceeded(runBrand(fixture, '--docs', 'packages/docs'));
    const brandedDocs = readFileSync(docsPath, 'utf8');
    assert.equal(brandedDocs.includes(String.raw`# Acme \[portal\]\(https://example.invalid\)`), true);
    assert.equal(brandedDocs.includes('[portal](https://example.invalid)'), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('escapes block-level Markdown markers in branded prose', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: '# Brand',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertSucceeded(runBrand(fixture));
    const docsFixtureDir = path.join(fixture, 'packages/docs/content');
    mkdirSync(docsFixtureDir, { recursive: true });
    const docsPath = path.join(docsFixtureDir, 'markdown-block.md');
    writeFileSync(docsPath, 'OpenChamber\n');
    assertSucceeded(runBrand(fixture, '--docs', 'packages/docs'));
    assert.equal(readFileSync(docsPath, 'utf8'), `${String.raw`\# Brand`}\n`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('escapes ordered-list, fence, and setext Markdown product names', { timeout: 30_000 }, () => {
  const cases = [
    ['# Brand', '\\# Brand'],
    ['- Brand', '\\- Brand'],
    ['+ Brand', '\\+ Brand'],
    ['> Brand', '\\&gt; Brand'],
    ['1. Brand', '1\\. Brand'],
    ['1) Brand', '1\\) Brand'],
    ['```Brand', '\\`\\`\\`Brand'],
    ['~~~Brand', '\\~\\~\\~Brand'],
    ['===', '\\=\\=\\='],
  ];
  for (const [name, expected] of cases) {
    const fixture = copyFixture();
    try {
      const alternateConfig = {
        ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
        name,
      };
      writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
      assertSucceeded(runBrand(fixture));
      const docsFixtureDir = path.join(fixture, 'packages/docs/content');
      mkdirSync(docsFixtureDir, { recursive: true });
      const docsPath = path.join(docsFixtureDir, 'markdown-block.md');
      writeFileSync(docsPath, 'OpenChamber\n');
      assertSucceeded(runBrand(fixture, '--docs', 'packages/docs'));
      assert.equal(readFileSync(docsPath, 'utf8'), `${expected}\n`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});
test('installer treats percent and backslash branding as data', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: String.raw`Percent %s \c`,
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertSucceeded(runBrand(fixture));
    const installer = readFileSync(path.join(fixture, 'scripts/install.sh'), 'utf8');
    const electronPackage = JSON.parse(readFileSync(path.join(fixture, 'packages/electron/package.json'), 'utf8'));
    assert.equal(electronPackage.build.linux.desktop.entry.Name, String.raw`Percent %s \\c`);
    assert.equal(electronPackage.build.linux.desktop.entry.Comment, String.raw`Desktop runtime for Percent %s \\c`);
    const marker = installer.split('\n').find((line) => line.includes('# brand:mark') === false && line.includes("printf '%s\\n'"));
    assert.equal(marker, String.raw`    printf '%s\n' '  ${brandConfig.mark}  Percent %s \c'`);
    assert.match(installer, /printf '%b  %s\\n'/g);
    assert.equal(spawnSync('bash', ['-n', path.join(fixture, 'scripts/install.sh')], { encoding: 'utf8' }).status, 0);
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
test('rejects leading whitespace in product names', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: ' Fixture Brand',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /name must not start with whitespace/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('rejects template placeholder braces in configured branding values', () => {
  const fixture = copyFixture();
  try {
    const alternateConfig = {
      ...JSON.parse(readFileSync(path.join(fixture, 'branding/brand.json'), 'utf8')),
      name: 'Fixture {Brand}',
    };
    writeFileSync(path.join(fixture, 'branding/brand.json'), `${JSON.stringify(alternateConfig, null, 2)}\n`);
    assertFailedWith(runBrand(fixture), /name must not contain template placeholder braces/);
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
  assert.equal(englishBundle['Smarty Code: No folder is open. Open a folder to start a new session.'], 'Smarty Code: No folder is open. Open a folder to start a new session.');
  assert.equal(frenchBundle['Smarty Code: No folder is open. Open a folder to start a new session.'], 'Smarty Code : aucun dossier n’est ouvert. Ouvrez un dossier pour démarrer une nouvelle session.');
  const agentControlDocs = readFileSync(path.join(root, 'packages/docs/content/docs/agent-control-tool.mdx'), 'utf8');
  assert.match(agentControlDocs, /Create a scheduled task in Smarty Code named Weekday review/);
  assert.doesNotMatch(agentControlDocs, /Create an Smarty Code/);
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
  assert.match(pwaRoute, /description: `\$\{PRODUCT_NAME\} AI coding workspace`/);
  assert.match(webIndex, /description: __PRODUCT_NAME_JSON__ \+ ' AI coding workspace'/);

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
