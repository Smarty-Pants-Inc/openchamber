import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { widgetSymbol } from './brand-widget-symbol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = 'packages/mobile/ios/App/OpenChamberWidget/Assets.xcassets';
const symbol = `${catalog}/OCLogoSymbol.symbolset/oclogo-symbol.svg`;
const stock = '2dfd1190eba8853c766c29ae27f09aeacc86bdb9';
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('generated widget keeps stock SF Symbols structure and approved artwork in every glyph', () => {
  const source = read(symbol);
  assert.equal(sha256(source.split('    <g id="Symbols">')[0]), 'a96cc326e9180d3e2a0b959f0d25232e05696f4fc0f12ef68f3476b9e1485b0b');
  assert.match(source, /https:\/\/github.com\/swhitty\/SwiftDraw/);
  for (const weight of ['Ultralight', 'Regular', 'Black']) {
    assert.match(source, new RegExp(`id="${weight}-S"`));
  }
  assert.equal((source.match(/cx="256" cy="256" r="222"/g) ?? []).length, 3);
  assert.ok(JSON.parse(read('branding/generated.json')).files[symbol]);
  assert.equal(JSON.parse(read(`${catalog}/OCLogoSymbol.symbolset/Contents.json`)).symbols[0].filename, 'oclogo-symbol.svg');
});

test('symbol generation requires valid artwork bounds and the stock insertion point', () => {
  const template = read('branding/symbol-template.svg');
  assert.throws(() => widgetSymbol(template, '<svg></svg>'), /viewBox/);
  assert.throws(() => widgetSymbol(template, '<svg viewBox="0 0 0 10"><path/></svg>'), /viewBox/);
  assert.throws(() => widgetSymbol('<svg/>', read('branding/logo.svg')), /template marker/);
});

test('Apple asset compiler accepts isolated exact-stock and candidate widget catalogs', {
  skip: process.platform !== 'darwin' ? 'Requires Mac Xcode/actool; Linux checks are not native proof' : false,
}, (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'smarty-widget-actool-'));
  const run = (command, args, options = {}) => spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 60_000, ...options,
  });
  const succeed = (result, label) => assert.equal(result.status, 0, `${label}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  try {
    for (const [command, args] of [['xcodebuild', ['-version']], ['xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']]]) {
      const result = run(command, args);
      succeed(result, command);
      t.diagnostic(result.stdout.trim());
    }
    let stockCatalog = process.env.SMARTY_STOCK_WIDGET_CATALOG;
    if (!stockCatalog) {
      const archive = run('git', ['archive', '--format=tar', stock, '--', catalog], { encoding: 'buffer' });
      succeed(archive, 'Export stock catalog; source archives can set SMARTY_STOCK_WIDGET_CATALOG');
      const source = path.join(fixture, 'stock-source');
      mkdirSync(source);
      succeed(run('tar', ['-xf', '-', '-C', source], { input: archive.stdout }), 'Extract stock catalog');
      stockCatalog = path.join(source, catalog);
    }
    for (const [label, source] of [['stock', stockCatalog], ['candidate', path.join(root, catalog)]]) {
      const input = path.join(fixture, label, 'Assets.xcassets');
      const output = path.join(fixture, label, 'compiled');
      cpSync(source, input, { recursive: true });
      mkdirSync(output);
      const result = run('xcrun', ['actool', input, '--compile', output,
        '--platform', 'iphoneos', '--minimum-deployment-target', '18.0',
        '--target-device', 'iphone', '--output-format', 'human-readable-text',
        '--notices', '--warnings', '--errors']);
      t.diagnostic(`${label} symbol SHA256: ${sha256(readFileSync(path.join(input, 'OCLogoSymbol.symbolset/oclogo-symbol.svg')))}\n${result.stdout}\n${result.stderr}`);
      succeed(result, `${label} actool`);
      assert.ok(existsSync(path.join(output, 'Assets.car')), `${label}: missing Assets.car`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
