// smarty-code#1489: the installed app is called "Smarty Code" on the home screen (manifest short_name and the iOS title).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';
import { PRODUCT_NAME } from '../../../brand.generated.js';

async function manifestFor(query, settings = {}) {
  const routes = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    registerPwaManifestRoute({ get: (route, handler) => routes.set(route, handler) }, {
      process: { platform: 'linux' },
      resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
      buildOpenCodeUrl: (route) => route,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => settings,
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });
    let body = '';
    await routes.get('/manifest.webmanifest')({ query }, { setHeader() { return this; }, type() { return this; }, send(value) { body = value; return this; } });
    return JSON.parse(body);
  } finally { globalThis.fetch = originalFetch; }
}

describe('installed app name', () => {
  it('the default manifest short_name is the whole product name', async () => {
    expect(PRODUCT_NAME).toBe('Smarty Code');
    const manifest = await manifestFor({});
    expect(manifest.short_name).toBe('Smarty Code');
    expect(manifest.name.startsWith('Smarty Code')).toBe(true);
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
  });

  it('a name the person chose is kept, cut to 30 characters for short_name', async () => {
    expect((await manifestFor({ appName: 'Work' })).short_name).toBe('Work');
    const long = await manifestFor({}, { pwaAppName: 'A very long installed application name' });
    expect(long.short_name).toBe('A very long installed applicat');
  });

  it('a chosen name that equals the default text is still the person\'s own (cut to 30), not the default', async () => {
    const same = `${PRODUCT_NAME} - AI Coding Assistant`;
    expect((await manifestFor({ appName: same })).short_name).toBe(same.slice(0, 30));
    expect((await manifestFor({}, { pwaAppName: same })).short_name).toBe(same.slice(0, 30));
  });

  it('index.html: iOS title, home-screen capable, client fallback short_name', () => {
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="__PRODUCT_NAME_HTML__" />');
    expect(html).not.toMatch(/apple-mobile-web-app-title" content="(?!__PRODUCT_NAME_HTML__)/);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('<meta name="theme-color"');
    expect(html).toContain('const defaultShortName = __PRODUCT_NAME_JSON__;');
    expect(html).toContain('appName === defaultAppName ? defaultShortName');
  });
});
