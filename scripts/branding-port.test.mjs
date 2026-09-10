import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('branding leaves prominent upstream gratitude and technical examples intact', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'smarty-brand-docs-'));
  try {
    mkdirSync(path.join(fixture, 'branding'));
    mkdirSync(path.join(fixture, 'docs'));
    writeFileSync(path.join(fixture, 'branding/brand.json'), JSON.stringify({
      name: 'Fixture <Brand> & [link]', mark: 'F',
      presentationAliases: ['OpenChamber', 'Smarty Code'],
    }));
    const attribution = read('README.md').match(/<!-- upstream-attribution:start -->[\s\S]*?<!-- upstream-attribution:end -->/)?.[0];
    assert.ok(attribution);
    assert.match(attribution, /Thank you, OpenChamber/);
    assert.match(attribution, /https:\/\/github.com\/openchamber\/openchamber/);
    const command = '`openchamber serve --port 3000`';
    const input = `${attribution}\n# OpenChamber\n${command}\n`;
    const file = path.join(fixture, 'docs/README.md');
    writeFileSync(file, input);
    const run = (...args) => spawnSync(process.execPath, [
      path.join(root, 'scripts/apply-brand.mjs'), '--root', fixture, '--docs', 'docs', ...args,
    ], { encoding: 'utf8' });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(file, 'utf8');
    assert.ok(output.startsWith(attribution));
    assert.ok(output.includes(command));
    assert.ok(output.includes('# Fixture &lt;Brand&gt; &amp; \\[link\\]'));
    assert.equal(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(file, 'utf8'), output);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('upstream license and authorship survive product presentation changes', () => {
  assert.equal(sha256(read('LICENSE')), '1f6e869a3feff6b4eb07907afc89176562b1f4324389f163d9fd94f09864b44e');
  assert.equal(json('package.json').author, 'Bohdan Triapitsyn');
  assert.equal(json('packages/electron/package.json').author, 'OpenChamber');
  assert.doesNotMatch(read('packages/ui/src/lib/theme/themes/index.ts'), /author:\s*brand/);
});

test('owned prompts differ from exact stock only at the four product labels', () => {
  const source = read('packages/ui/src/lib/magicPrompts.ts');
  assert.equal((source.match(/\$\{PRODUCT_NAME\}/g) ?? []).length, 4);
  const normalized = source
    .replace("import { PRODUCT_NAME } from './brand.generated';\n", '')
    .replaceAll('${PRODUCT_NAME}', 'OpenChamber');
  assert.equal(sha256(normalized), '1938568278ca003bd3a6c48a5464bee060e55acfeea4ed50adf610d7162c1395');
});

test('all 98 donor raster variants retain their platform-specific dimensions', () => {
  const parity = json('branding/asset-parity.json');
  const manifest = json('branding/generated.json');
  const assets = Object.entries(parity.pngDimensions);
  assert.equal(assets.length, 98);
  assert.deepEqual(Object.keys(manifest.files).filter((file) => file.endsWith('.png')).sort(), assets.map(([file]) => file).sort());
  for (const [file, dimensions] of assets) {
    const png = readFileSync(path.join(root, file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], dimensions, file);
  }
});

test('native packaging keeps compatibility identifiers while branding every command category', () => {
  const electron = json('packages/electron/package.json');
  assert.equal(electron.build.appId, 'dev.openchamber.desktop');
  assert.equal(electron.build.mac.executableName, 'OpenChamber');
  assert.equal(electron.build.win.executableName, 'OpenChamber');
  assert.equal(electron.build.linux.executableName, 'openchamber');
  assert.equal(electron.build.linux.desktop.entry.StartupWMClass, 'openchamber');
  for (const platform of ['mac', 'win', 'linux']) {
    assert.equal(electron.build[platform].icon, 'resources/icons/app-icon.png');
  }
  const vscode = json('packages/vscode/package.json');
  assert.equal(vscode.name, 'openchamber');
  assert.equal(vscode.publisher, 'fedaykindev');
  assert.equal(vscode.icon, 'assets/app-icon.png');
  for (const command of vscode.contributes.commands) {
    assert.equal(command.category, '%product.name%', command.command);
    assert.ok(command.command.startsWith('openchamber.'));
  }
  const native = read('packages/electron/main.mjs');
  assert.match(native, /app\.setPath\('logs', legacyLogsPath\)/);
  assert.match(native, /app\.setPath\('userData', isDev \? path\.join\(app\.getPath\('appData'\), `\$\{LEGACY_PRODUCT_NAME\} Dev`\) : legacyUserDataPath\)/);
});

test('documented CLI help uses product identity without renaming real commands', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'smarty-brand-cli-'));
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'packages/web/bin/cli.js'), '--help'], {
      cwd: home, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', OPENCHAMBER_DATA_DIR: path.join(home, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Smarty Code/);
    assert.match(result.stdout, /openchamber/);
    assert.doesNotMatch(result.stdout, /OpenChamber CLI|smarty-code serve/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
