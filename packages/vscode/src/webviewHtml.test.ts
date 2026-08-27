import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('./webviewHtml.ts', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('./extension.ts', import.meta.url), 'utf8');

describe('VS Code webview content security policy', () => {
  test('allows blob URLs for workers without allowing blob scripts', () => {
    const workerSource = source.match(/const workerSrc = ([^\n]+);/)?.[1] ?? '';
    const scriptSource = source.match(/const scriptSrc = ([^\n]+);/)?.[1] ?? '';

    assert.match(workerSource, /'blob:'/);
    assert.doesNotMatch(scriptSource, /'blob:'/);
    assert.match(source, /worker-src \$\{workerSrc\}/);
  });
});

describe('VS Code branding boundaries', () => {
  test('brands localization templates before inserting arguments', () => {
    assert.match(extensionSource, /vscode\.l10n\.t\(brandText\(message\), \.\.\.args\)/);
    assert.doesNotMatch(extensionSource, /brandText\(vscode\.l10n\.t/);
    assert.match(extensionSource, /Last error: \$\{debug\.lastError\}/);
  });

  test('uses the product template for the API and the technical executable identity for CLI errors', () => {
    assert.match(source, /startingApi: 'Starting \$\{PRODUCT_NAME\} API…'/);
    assert.match(source, /The opencode executable was not found\. Install the opencode CLI first\./);
    assert.doesNotMatch(source, /OpenCode CLI not found/);
  });
});
