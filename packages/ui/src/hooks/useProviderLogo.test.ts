import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { useProviderLogo as ProviderLogoHook } from './useProviderLogo';
// Optional read-only dependency root for an unhydrated source checkout.
const dependencyRequire = createRequire(process.env.NODE_PATH
    ? resolve(process.env.NODE_PATH, 'package.json') : import.meta.url);
const React: typeof import('react') = dependencyRequire('react');
const { act } = React;
const { createRoot }: typeof import('react-dom/client') = dependencyRequire('react-dom/client');
const { Window }: typeof import('happy-dom') = dependencyRequire('happy-dom');
const ts: typeof import('typescript') = dependencyRequire('typescript');
const transpile = (text: string) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const source = readFileSync(new URL('./useProviderLogo.ts', import.meta.url), 'utf8');

// Inert witness using real React hooks. Reuse the Vite-glob substitution from
// ElectronMiniChatApp.recovery.test.tsx; evaluate unchanged hook/preloader code
// in a VM with injected React imports and an Image recorder, never image loading.
const browser = new Window({ url: 'http://offline.test' });
const install = <T,>(name: string, value: T) => Object.defineProperty(globalThis, name, {
    configurable: true, writable: true, value,
});
install('window', browser);
install('document', browser.document);
install('IS_REACT_ACT_ENVIRONMENT', true);
install('fetch', async () => { throw new Error('Network forbidden in inert witness'); });
const imageAssignments: string[] = [];
class InertImage {
    decoding = '';
    onerror: (() => void) | null = null;
    set src(value: string) { imageAssignments.push(value); }
    decode() { return Promise.resolve(); }
}
install('Image', InertImage);
const logos = Object.fromEntries(readdirSync(new URL('../assets/provider-logos/', import.meta.url))
    .filter(name => name.endsWith('.svg'))
    .map(name => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
const logoCode = transpile(source
    .replace("import { useState, useCallback, useEffect } from 'react';", '')
    .replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`)
    .replaceAll('export ', '') + '\nglobalThis.logoExports = { useProviderLogo, preloadProviderLogos };');
const { useProviderLogo, preloadProviderLogos }: typeof import('./useProviderLogo') = runInNewContext(logoCode, {
    useState: React.useState, useCallback: React.useCallback, useEffect: React.useEffect, Image: InertImage,
});
afterAll(async () => { await browser.happyDOM.abort(); });

async function logoWitness(providerId: string, failLocal = false) {
    let result: ReturnType<typeof ProviderLogoHook> = { src: null, hasLogo: false, onError() {} };
    function Owner() { result = useProviderLogo(providerId); return null; }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(React.createElement(Owner)));
        if (failLocal) await act(async () => result.onError());
        return result.src;
    } finally { await act(async () => root.unmount()); }
}

const external = (values: readonly string[]) => values.filter(value => /^https?:\/\//.test(value));

test('smarty-fixture hook does not select an external logo', async () => {
    expect(await logoWitness('smarty-fixture')).toBeNull();
});
test('bundled provider hook and preload use local assets', async () => {
    expect(await logoWitness('openai')).toBe('/assets/provider-logos/openai.svg');
    imageAssignments.length = 0;
    preloadProviderLogos(['openai']);
    expect(imageAssignments).toEqual(['/assets/provider-logos/openai.svg']);
});
test('smarty-fixture preload does not assign an external URL', () => {
    imageAssignments.length = 0;
    preloadProviderLogos(['smarty-fixture']);
    expect(external(imageAssignments)).toEqual([]);
});
test('local asset failure does not select an external logo', async () => {
    expect(await logoWitness('openai', true)).toBeNull();
});

// Execute the exact private acquisition function without importing the large
// store or its startup effects. Catalog transformation is an explicit inert
// seam here, returning an empty map. This proves fetch selection,
// not store integration or catalog parsing.
const configSource = readFileSync(new URL('../stores/useConfigStore.ts', import.meta.url), 'utf8');
const acquisition = configSource.slice(configSource.indexOf('const fetchModelsDevMetadata ='),
    configSource.indexOf('let modelsMetadataInFlight:'));
const metadataCode = transpile(acquisition + '\nfetchModelsDevMetadata();');
async function metadataWitness(localOK: boolean) {
    const requests: string[] = [];
    await runInNewContext(metadataCode, {
        MODELS_DEV_PROXY_URL: '/api/openchamber/models-metadata',
        MODELS_DEV_API_URL: 'https://models.dev/api.json',
        AbortController, setTimeout, clearTimeout,
        console: { warn() {} },
        runtimeFetch: async (url: string) => {
            requests.push(url);
            return localOK ? Response.json({}) : new Response('', { status: 502 });
        },
        fetch: async (url: string) => { requests.push(url); throw new Error('External IO blocked'); },
        transformModelsDevResponse: () => new Map(),
    });
    return requests;
}
test('same-origin empty catalog avoids direct external metadata fetch', async () => {
    expect(await metadataWitness(true)).toEqual(['/api/openchamber/models-metadata']);
});
test('failed same-origin metadata does not attempt external fallback', async () => {
    expect(await metadataWitness(false)).toEqual(['/api/openchamber/models-metadata']);
});

describe('provider logo aliases', () => {
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(source).toContain("compact.startsWith('exe-') ? 'exe-dev' : undefined");
        expect(source).toContain('const candidates = [prefixAlias,');
    });
});
