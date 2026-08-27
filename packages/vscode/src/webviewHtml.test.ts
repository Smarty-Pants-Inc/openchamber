import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('./webviewHtml.ts', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('./extension.ts', import.meta.url), 'utf8');
const opencodeSource = readFileSync(new URL('./opencode.ts', import.meta.url), 'utf8');
const englishBundle = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.json', import.meta.url), 'utf8')) as Record<string, string>;
const frenchBundle = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.fr.json', import.meta.url), 'utf8')) as Record<string, string>;

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
    assert.match(opencodeSource, /vscode\.l10n\.t\(brandText\(message\), \.\.\.args\)/);
    assert.doesNotMatch(opencodeSource, /brandText\(vscode\.l10n\.t/);
  });

  test('uses the product template for the API and technical opencode identity for executable errors', () => {
    assert.match(source, /startingApi: 'Starting \$\{PRODUCT_NAME\} API…'/);
    assert.match(source, /The opencode executable was not found\. Install the opencode CLI first\./);
    assert.match(opencodeSource, /t\('Failed to start \{0\}: \{1\}', PRODUCT_NAME, message\)/);
    assert.doesNotMatch(opencodeSource, /OpenCode CLI not found|Failed to start OpenCode/);
    assert.equal(englishBundle['smarty-code: Failed to open sidebar - {0}'], 'smarty-code: Failed to open sidebar - {0}');
    assert.equal(frenchBundle['smarty-code: Failed to open sidebar - {0}'], 'smarty-code : impossible d’ouvrir la barre latérale — {0}');
    assert.equal(englishBundle['Failed to start {0}: {1}'], 'Failed to start {0}: {1}');
    assert.equal(frenchBundle['Failed to start {0}: {1}'], 'Impossible de démarrer {0} : {1}');
    assert.equal(englishBundle['The opencode executable was not found. Install the opencode CLI first.'], 'The opencode executable was not found. Install the opencode CLI first.');
    assert.equal(frenchBundle['The opencode executable was not found. Install the opencode CLI first.'], 'L’exécutable opencode est introuvable. Installez d’abord le CLI opencode.');
  });
});
