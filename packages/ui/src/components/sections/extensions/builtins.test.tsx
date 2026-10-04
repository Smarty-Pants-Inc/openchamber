import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { createWebAPIs } from '../../../../../web/src/api';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { usePluginsStore, type PluginEntry } from '@/stores/usePluginsStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getSettingsSaveState, reportSettingsSaveState } from '@/lib/persistence';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { ExtensionsPage } from './ExtensionsPage';
import { IntegrationsPage } from '../integrations/IntegrationsPage';
import { PluginsPage } from '../plugins/PluginsPage';

const builtIn: InstalledGuest = {
  id: 'openchamber-builtin-sdk-demo', name: 'SDK Demo', icon: 'apps', entry: 'panel/index.html', source: 'bundled', enabled: true, version: '1.23.2',
  capabilities: { requested: ['files', 'sessions', 'network'], granted: ['files', 'sessions', 'network'] },
  integration: { name: 'SDK Demo', description: 'GitHub', auth: 'token' },
};
const installed: InstalledGuest = { ...builtIn, id: 'third-party', name: 'Third-party', source: 'git', origin: { url: 'git@github.com:acme/third-party.git' }, integration: { name: 'Third-party', description: 'GitHub', auth: 'token' } };
const originalRuntimeKey = getRuntimeKey();
const originalBase = getRuntimeApiBaseUrl();

// The fork deliberately removed upstream Guest SDK admission in smarty-code#1325.
// These records remain installed/enabled at the host; settings must not fetch or expose them.
const plugin: PluginEntry = {
  id: 'opencode-plugin', spec: 'opencode-example@1.0.0', scope: 'user', kind: 'config', parsedKind: 'npm',
};

const GuestCatalogConsumer = () => {
  const surfaces = useGuestSurfaces();
  return <output data-guest-surfaces>{JSON.stringify(surfaces)}</output>;
};

describe('fork guest settings policy', () => {
  let dom: Window;
  let root: Root;
  let container: HTMLElement;
  let catalog: InstalledGuest[];
  let requests: string[];
  let bodies: Array<string | null>;
  let pluginSpec: string;
  let linearConnected: boolean;
  let failPreferencesSave: boolean;
  let restoreFetch = () => {};
  const globals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    catalog = structuredClone([builtIn, installed]);
    requests = [];
    bodies = [];
    pluginSpec = plugin.spec;
    linearConnected = false;
    failPreferencesSave = false;
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    useGuestOauthStore.getState().resetForRuntimeSwitch();
    useGitHubAuthStore.getState().resetForRuntimeSwitch();
    useLinearAuthStore.getState().resetForRuntimeSwitch();
    usePluginsStore.setState({ entries: [], files: [], selectedId: null, draft: null, registryInfo: {} });
    registerRuntimeAPIs(createWebAPIs());
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url, 'http://localhost').pathname;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      requests.push(`${method} ${path}`);
      bodies.push(init?.body == null ? null : String(init.body));
      // An enabled upstream host is offered, rather than a 501 that could hide a UI regression.
      if (path === '/api/guests') return Response.json({ guests: catalog });
      if (path === '/api/guests/updates/check') return Response.json({ updates: {} });
      if (path.startsWith('/api/guests/')) return Response.json({ connected: true, account: 'Stored guest', hasClient: true, settings: {}, redirectUri: '' });
      if (path === '/api/github/auth/status') return Response.json({ connected: false });
      if (path === '/api/github/auth/start') return Response.json({
        deviceCode: 'fixture-device', userCode: 'FIXTURE', verificationUri: 'https://github.example.test/device', expiresIn: 600, interval: 600,
      });
      if (path === '/api/linear/auth/status') return Response.json({ connected: linearConnected });
      if (path === '/api/linear/auth/start') return Response.json({ authorizationUrl: 'https://linear.example.test/authorize', expiresIn: 600, scope: 'read' });
      if (path === '/api/linear/mapping') return Response.json({ connected: true, defaultProjectPath: null, teams: [] });
      if (path === '/api/linear/preferences') {
        if (method === 'PUT' && failPreferencesSave) return Response.json({ error: 'fixture-save-failed' }, { status: 503 });
        return Response.json({ sessionComments: method === 'PUT' });
      }
      if (path === '/api/config/plugins') return Response.json({ entries: [{ ...plugin, spec: pluginSpec }], files: [] });
      if (path === `/api/config/plugins/entry/${plugin.id}` && method === 'PATCH') return Response.json({ success: true });
      if (path === '/api/config/plugins/registry') return Response.json({ results: [] });
      if (path === '/auth/url-token') return new Response('', { status: 409 });
      if (path === '/api/git/identities') return Response.json([]);
      if (path === '/api/git/global-identity') return Response.json({ userName: '', userEmail: '', sshCommand: null });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    restoreFetch = () => fetch.mockRestore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntimeKey });
    await new Promise(resolve => setTimeout(resolve, 0));
    clearRuntimeAuthCredentialProvider();
    clearRuntimeUrlAuthToken();
    useGuestOauthStore.getState().resetForRuntimeSwitch();
    useGitHubAuthStore.getState().resetForRuntimeSwitch();
    useLinearAuthStore.getState().resetForRuntimeSwitch();
    usePluginsStore.setState({ entries: [], files: [], selectedId: null, draft: null, registryInfo: {} });
    registerRuntimeAPIs(null);
    restoreFetch();
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    await dom.happyDOM.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async (page: React.ReactNode) => {
    await act(async () => { root.render(<I18nProvider><TooltipProvider>{page}</TooltipProvider></I18nProvider>); });
  };
  const button = (text: string, parent: ParentNode = container) => {
    const result = [...parent.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
    if (!result) throw new Error(`Missing button: ${text}`);
    return result;
  };

  const expectGuestsUnavailable = () => {
    expect(useGuestsStore.getState()).toMatchObject({ status: 'unsupported', guests: [], failure: null, runtimeKey: getRuntimeKey() });
    expect(container.textContent).not.toContain('SDK Demo');
    expect(container.textContent).not.toContain('Third-party');
    expect(container.querySelector('[data-settings-item="integrations.guests"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    // Covers catalog, OAuth, updates, enable, approval, install and deletion, for every method.
    expect(requests.filter((entry) => entry.includes(' /api/guests'))).toEqual([]);
    expect(catalog).toEqual([builtIn, installed]);
  };

  test('the real Extensions page loads an unsupported catalog, with no guest controls or requests', async () => {
    await render(<ExtensionsPage />);
    expectGuestsUnavailable();
    expect(container.textContent).toContain('This settings page is not available in this runtime.');
    expect(container.textContent).not.toContain('web and desktop');
    expect(container.querySelector('[data-settings-item="extensions.add"]')).toBeNull();
    expect(container.querySelector('[data-settings-item="extensions.updates.check"]')).toBeNull();
    const labels = [...container.querySelectorAll('button')].map((entry) => entry.textContent?.trim());
    for (const label of ['Enable', 'Disable', 'Remove', 'Review permissions', 'Open source']) {
      expect(labels).not.toContain(label);
    }
    expect(container.querySelector('[data-settings-page-heading]')).toBeTruthy();
  });

  test('a stored enabled bundled and user catalog is retired before refreshed settings mount', async () => {
    const runtimeKey = getRuntimeKey();
    useGuestsStore.getState().replaceCatalog(catalog, runtimeKey);
    for (const guest of catalog) {
      useGuestOauthStore.getState().setStatus(guest.id, {
        connection: { connected: true, account: 'Stored guest' }, hasClient: true, settings: {}, redirectUri: '',
      });
    }
    expect(useGuestsStore.getState().guests).toHaveLength(2);
    // Use the real policy loader, never markUnsupported in the fixture or mock the loader.
    await loadGuestCatalog();
    await render(<><ExtensionsPage /><IntegrationsPage /></>);
    expectGuestsUnavailable();
    expect(Object.keys(useGuestOauthStore.getState().byId)).toHaveLength(2);
    expect(container.querySelector('[data-settings-item="integrations.first-party"]')?.textContent).toContain('GitHub');
    expect(container.querySelector('[data-settings-item="integrations.first-party"]')?.textContent).toContain('Linear');
  });

  test('Integrations loads no guest accounts while GitHub and Linear controls reach their own APIs', async () => {
    await render(<IntegrationsPage />);
    expectGuestsUnavailable();
    const github = container.querySelector('[data-settings-item="integrations.github"]');
    const linear = container.querySelector('[data-settings-item="integrations.linear"]');
    if (!github || !linear) throw new Error('Missing first-party integration controls');
    const githubTrigger = github.querySelector('button');
    const linearTrigger = linear.querySelector('button');
    if (!githubTrigger || !linearTrigger) throw new Error('Missing first-party card triggers');
    const open = spyOn(window, 'open').mockImplementation(() => null);
    try {
      await act(async () => { githubTrigger.click(); linearTrigger.click(); });
      expect(requests).toContain('GET /api/github/auth/status');
      expect(requests).toContain('GET /api/linear/auth/status');
      await act(async () => { button('Connect GitHub', github).click(); button('Connect', linear).click(); });
      expect(requests).toContain('POST /api/github/auth/start');
      expect(requests).toContain('POST /api/linear/auth/start');
      expect(open.mock.calls.map(([url]) => url).sort()).toEqual(['https://github.example.test/device', 'https://linear.example.test/authorize']);
      // The old source-opening assertion is replaced by retained first-party browser actions.
      expect(open.mock.calls.every(([, target, features]) => target === '_blank' && features === 'noopener,noreferrer')).toBe(true);
      expectGuestsUnavailable();
    } finally { open.mockRestore(); }
  });

  test('OpenCode plugin settings still load, edit and save through their non-guest path', async () => {
    await render(<ExtensionsPage />);
    await act(async () => {
      expect(await usePluginsStore.getState().loadPlugins({ force: true })).toBe(true);
      usePluginsStore.getState().setSelected(plugin.id);
    });
    await render(<PluginsPage />);
    expect(container.querySelector('[data-settings-item="plugins.spec"] input')?.getAttribute('value')).toBe(plugin.spec);
    expect(container.querySelector('[data-settings-item="plugins.options"] textarea')).toBeTruthy();
    expect(button('Save').disabled).toBe(true);
    await act(async () => {
      const draft = usePluginsStore.getState().draft;
      if (!draft) throw new Error('Missing OpenCode plugin draft');
      pluginSpec = 'opencode-example@1.1.0';
      usePluginsStore.getState().setDraft({ ...draft, spec: pluginSpec });
    });
    expect(button('Save').disabled).toBe(false);
    await act(async () => { button('Save').click(); });
    const save = requests.indexOf(`PATCH /api/config/plugins/entry/${plugin.id}`);
    expect(save).toBeGreaterThanOrEqual(0);
    expect(bodies[save]).toBe(JSON.stringify({ spec: pluginSpec }));
    expect(usePluginsStore.getState().entries[0]?.spec).toBe(pluginSpec);
    expect(button('Save').disabled).toBe(true);
    expectGuestsUnavailable();
  });

  test('retains first-party save feedback and runtime reset without resurrecting guest accounts', async () => {
    linearConnected = true;
    await render(<><GuestCatalogConsumer /><ExtensionsPage /><IntegrationsPage /></>);
    const linear = container.querySelector('[data-settings-item="integrations.linear"]');
    const trigger = linear?.querySelector('button');
    if (!trigger) throw new Error('Missing Linear settings');
    await act(async () => { trigger.click(); });
    const comments = container.querySelector<HTMLElement>('[data-settings-item="integrations.linear.session-comments"] [role="switch"]');
    if (!comments) throw new Error('Missing Linear preference switch');
    expect(comments.getAttribute('aria-disabled')).not.toBe('true');
    expect(comments.hasAttribute('data-disabled')).toBe(false);
    expect(comments.getAttribute('aria-checked')).toBe('false');
    await act(async () => { comments.click(); });
    expect(requests).toContain('PUT /api/linear/preferences');
    expect(comments.getAttribute('aria-checked')).toBe('true');
    expect(getSettingsSaveState()).toBe('idle');
    failPreferencesSave = true;
    await act(async () => { comments.click(); });
    expect(comments.getAttribute('aria-checked')).toBe('true');
    expect(getSettingsSaveState()).toBe('error');
    expect(container.querySelector('[aria-live="assertive"]')?.textContent).toContain('Save failed');
    // Preserve the original shared saving/reset contract. This signal is explicit,
    // not a claim that LinearSessionComments reports an in-flight save itself.
    await act(async () => { reportSettingsSaveState('saving'); });
    expect(getSettingsSaveState()).toBe('saving');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
    expect(container.textContent).toContain('Saving');
    const previousRuntimeKey = getRuntimeKey();
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://enabled-next.example.test', runtimeKey: 'enabled-next' });
      // An obsolete response cannot restore the previous owner's enabled records.
      useGuestsStore.getState().replaceCatalog(catalog, previousRuntimeKey);
    });
    expect(getSettingsSaveState()).toBe('idle');
    expect(container.textContent).not.toContain('Saving');
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull();
    expect(container.querySelector('[data-guest-surfaces]')?.textContent).toBe('[]');
    expectGuestsUnavailable();
    expect(requests).toContain('POST /auth/url-token');
    expect(container.querySelector('[data-settings-item="integrations.github"]')).toBeTruthy();
    expect(container.querySelector('[data-settings-item="integrations.linear"]')).toBeTruthy();
  });
});
