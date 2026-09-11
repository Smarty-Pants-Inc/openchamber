import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectIdFromPath } from '@/lib/projectId';
import { Window } from 'happy-dom';
import type { SettingsSyncedDetail } from '@/lib/persistence';

const HOME = '/fixture/home';
const PROJECT = '/fixture/project';
const MARKER = 'PICKER_RECONCILIATION_TRACE ';
const arm = process.env.OC_PICKER_DIAGNOSTIC_ARM;

if (!arm) {
  test('paired stock picker reconciliation at OC612', () => {
    // Each arm needs fresh module singletons AND a window installed before imports.
    for (const choice of ['PROJECT', 'HOME']) {
      const child = spawnSync(process.execPath, ['test', fileURLToPath(import.meta.url)], {
        env: { ...process.env, OC_PICKER_DIAGNOSTIC_ARM: choice }, encoding: 'utf8',
      });
      const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
      const trace = output.split('\n').find((line) => line.startsWith(MARKER));
      // The existing isolated runner suppresses successful stdout. Keep native job summaries too.
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `\n### Picker reconciliation ${choice}\n\n\`\`\`json\n${trace?.slice(MARKER.length) ?? 'null'}\n\`\`\`\n`);
      console.log(output);
      expect(child.error).toBe(undefined);
      expect(child.status).toBe(0);
      expect(trace).toBeDefined();
    }
  }, 180_000);
} else {
  test('stock picker reconciliation arm', async () => {
    expect(['PROJECT', 'HOME']).toContain(arm);
    const win = new Window({ url: 'https://picker.test' });
    const values = {
      window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
      sessionStorage: win.sessionStorage, location: win.location,
      WebSocket: class { constructor() { denied.push('WebSocket'); throw new Error('Unexpected WebSocket outside SSE fixture'); } },
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLInputElement: win.HTMLInputElement, HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
      Event: win.Event, CustomEvent: win.CustomEvent, MouseEvent: win.MouseEvent, PointerEvent: win.PointerEvent,
      KeyboardEvent: win.KeyboardEvent, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
      getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    Object.defineProperty(win, '__OPENCHAMBER_HOME__', { value: HOME, configurable: true });
    win.localStorage.setItem('homeDirectory', HOME);
    const requests: string[] = [];
    const denied: string[] = [];
    const samples: string[] = [];
    const agent = { name: 'build', mode: 'primary', permission: {}, options: {} };
    const model = {
      id: 'smarty-e2e', name: 'Smarty E2E', providerID: 'fixture', status: 'active',
      api: { id: 'smarty-e2e', url: '', npm: '' }, options: {}, headers: {}, release_date: '',
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, interleaved: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false } },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 8192, output: 1024 },
    };
    const provider = { id: 'fixture', name: 'Fixture', source: 'config', env: [], options: {}, models: { 'smarty-e2e': model } };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(input.toString(), win.location.href), init);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api(?=\/)/, '');
      const directory = url.searchParams.get('directory') ?? request.headers.get('x-opencode-directory') ?? PROJECT;
      requests.push(`${request.method} ${url.pathname} ${directory}`);
      if (url.origin !== win.location.origin || request.method !== 'GET') {
        denied.push(`${request.method} ${url.origin}${url.pathname}`);
        throw new Error(`Unexpected fixture request: ${denied.at(-1)}`);
      }
      if (path === '/global/event') return new Response(new ReadableStream({
        start(controller) { request.signal.addEventListener('abort', () => controller.close(), { once: true }); },
      }), { headers: { 'content-type': 'text/event-stream' } });
      const bodies = new Map<string, string>([
        ['/global/health', { healthy: true, version: 'fixture' }], ['/health', { status: 'ok', openCodeReady: true }],
        ['/path', { state: '', config: '', worktree: directory, directory, home: HOME }],
        ['/fs/home', { home: HOME, homeDirectory: HOME, chatsRoot: `${HOME}/.config/openchamber/chats` }],
        ['/config/providers', { providers: directory === PROJECT ? [provider] : [], default: {} }],
        ['/agent', [agent]], ['/app/agents', [agent]], ['/project/current', { id: 'fixture-project', worktree: directory }],
        ['/project', []], ['/session', []], ['/command', []], ['/lsp', []], ['/question', []], ['/permission', []],
        ['/session/status', {}], ['/config', {}], ['/global/config', {}], ['/mcp', {}], ['/vcs', { branch: 'fixture' }],
        ['/openchamber/models-metadata', {}], ['/config/settings', {}],
        ['/permission-auto-accept', { sessions: {}, revision: 0 }], ['/message-queue', { sessions: [], revision: 0 }],
      ].map(([key, body]) => [String(key), JSON.stringify(body)]));
      if (!bodies.has(path)) { denied.push(path); throw new Error(`Unspecified fixture endpoint: ${path}`); }
      return new Response(bodies.get(path), { headers: { 'content-type': 'application/json' } });
    });
    let cleanup = async () => {};
    let closeLoader = async () => {};
    let outcome = 'assembly-failure';
    const transient = mkdtempSync(join(tmpdir(), 'picker-vite-'));
    try {
      const { createServer, createRunnableDevEnvironment, isRunnableDevEnvironment } = await import('vite');
      const uiRoot = fileURLToPath(new URL('../../../', import.meta.url));
      // ponytail: One isolated diagnostic owns this loader; extract only if shared coverage is admitted.
      const server = await createServer({ configFile: false, root: uiRoot, envDir: transient,
        cacheDir: join(transient, 'cache'), appType: 'custom',
        resolve: { alias: { '@': join(uiRoot, 'src'), '@openchamber/ui': join(uiRoot, 'src'),
          '@web': join(uiRoot, '../web/src'),
          '@opencode-ai/sdk/v2': join(uiRoot, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js') },
          dedupe: ['react', 'react-dom'] },
        server: { middlewareMode: true, ws: false, hmr: false, watch: null,
          fs: { allow: [join(uiRoot, '../..'), transient] } },
        optimizeDeps: { entries: ['src/components/chat/ModelControls.tsx', 'src/sync/sync-context.tsx'],
          include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
        environments: { client: { consumer: 'client', dev: { moduleRunnerTransform: true,
          createEnvironment: (name, config) => createRunnableDevEnvironment(name, config,
            { hot: false, runnerOptions: { hmr: false } }) } } } });
      closeLoader = () => server.close();
      expect(server.httpServer).toBe(null);
      const environment = server.environments.client;
      if (!isRunnableDevEnvironment(environment)) throw new Error('Vite client runner unavailable');
      const load = environment.runner.import.bind(environment.runner);
      const { default: React } = await load<{ default: typeof import('react') }>('react');
      const { default: { createRoot } } = await load<{ default: typeof import('react-dom/client') }>('react-dom/client');
      expect(typeof React.useState).toBe('function'); expect(typeof createRoot).toBe('function');
      const { createWebAPIs } = await load<typeof import('../../../../web/src/api')>(join(uiRoot, '../web/src/api/index.ts'));
      const { RuntimeAPIProvider } = await load<typeof import('@/contexts/RuntimeAPIProvider')>('/src/contexts/RuntimeAPIProvider.tsx');
      const { registerRuntimeAPIs } = await load<typeof import('@/contexts/runtimeAPIRegistry')>('/src/contexts/runtimeAPIRegistry.ts');
      const { SyncProvider } = await load<typeof import('@/sync/sync-context')>('/src/sync/sync-context.tsx');
      const { createOpencodeClient } = await load<typeof import('@opencode-ai/sdk/v2')>('@opencode-ai/sdk/v2');
      const { I18nProvider } = await load<typeof import('@/lib/i18n')>('/src/lib/i18n/index.ts');
      const { ModelControls } = await load<typeof import('./ModelControls')>('/src/components/chat/ModelControls.tsx');
      const { useOpenCodeReadiness } = await load<typeof import('@/hooks/useOpenCodeReadiness')>('/src/hooks/useOpenCodeReadiness.ts');
      const { useProjectsStore } = await load<typeof import('@/stores/useProjectsStore')>('/src/stores/useProjectsStore.ts');
      const { useDirectoryStore } = await load<typeof import('@/stores/useDirectoryStore')>('/src/stores/useDirectoryStore.ts');
      const { useConfigStore } = await load<typeof import('@/stores/useConfigStore')>('/src/stores/useConfigStore.ts');
      const { useUIStore } = await load<typeof import('@/stores/useUIStore')>('/src/stores/useUIStore.ts');
      const { opencodeClient } = await load<typeof import('@/lib/opencode/client')>('/src/lib/opencode/client.ts');
      const probePath = join(transient, 'probe.ts');
      writeFileSync(probePath, `export const ssr = import.meta.env.SSR; export const realm = window;
        export { useState } from 'react'; export { useConfigStore } from '@/stores/useConfigStore';`);
      const probe = await load<{ ssr: boolean; realm: Window; useState: typeof React.useState;
        useConfigStore: typeof useConfigStore }>(probePath);
      expect(probe.ssr).toBe(false); expect(probe.realm).toBe(win);
      expect(probe.useState).toBe(React.useState); expect(probe.useConfigStore).toBe(useConfigStore);
      const logo = environment.moduleGraph.getModuleById(join(uiRoot, 'src/hooks/useProviderLogo.ts'));
      const svgs = [...(logo?.importedModules ?? [])].filter((module) => module.file?.endsWith('.svg'));
      expect(svgs.length).toBeGreaterThan(0);
      const controls = environment.moduleGraph.getModuleById(join(uiRoot, 'src/components/chat/ModelControls.tsx'));
      expect([...controls?.importedModules ?? []].some((module) => module.file === join(uiRoot, 'src/stores/useConfigStore.ts'))).toBe(true);
      console.log('PICKER_LOADER_QUALIFIED ' + JSON.stringify({ ssr: probe.ssr, sharedRealm: true,
        sharedReact: true, sharedConfigStore: true, eagerSvgCount: svgs.length, consumer: environment.config.consumer }));
      const apis = createWebAPIs();
      registerRuntimeAPIs(apis);
      useConfigStore.setState({ settingsMessageStreamTransport: 'sse' });
      useProjectsStore.getState().synchronizeFromSettings({ projects:
        [HOME, PROJECT].map((path) => ({ path, id: createProjectIdFromPath(path) })) });
      const projects = useProjectsStore.getState().projects;
      const project = projects.find((entry) => entry.path === PROJECT);
      const home = projects.find((entry) => entry.path === HOME);
      if (!project || !home) throw new Error('Fixture project sanitization failed');
      const reconcile = (activeProjectId: string) => window.dispatchEvent(new CustomEvent<SettingsSyncedDetail>(
        'openchamber:settings-synced', { detail: { settings: { projects, activeProjectId }, bootstrap: true, adoptTheme: false } },
      ));
      reconcile(project.id);
      await useConfigStore.getState().initializeApp();
      await useConfigStore.getState().prewarmProjectConfigs(PROJECT);
      expect(denied).toEqual([]);
      const root = createRoot(document.body.appendChild(document.createElement('div')));
      const sdk = createOpencodeClient({ baseUrl: 'https://picker.test/api', fetch: globalThis.fetch });
      let ready = false;
      const search = () => document.querySelector<HTMLInputElement>('input[placeholder="Search models"]');
      const sample = (stage: string) => {
        const config = useConfigStore.getState();
        samples.push(JSON.stringify({ stage, active: useProjectsStore.getState().activeProjectId,
          directory: useDirectoryStore.getState().currentDirectory, client: opencodeClient.getDirectory(),
          configDirectory: config.activeDirectoryKey, initialized: config.isInitialized, providers: config.providers.length,
          ready, computedReady: config.isInitialized || config.providers.length > 0,
          requestedOpen: useUIStore.getState().isModelSelectorOpen,
          menuMounted: !!document.querySelector('[data-slot="dropdown-menu-content"]'),
          search: !!search()?.isConnected, disabled: search()?.disabled, readOnly: search()?.readOnly, value: search()?.value }));
      };
      const observer = new MutationObserver(() => sample('dom'));
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      const unsubscribers = [useProjectsStore.subscribe(() => sample('project')), useDirectoryStore.subscribe(() => sample('directory')),
        useConfigStore.subscribe(() => sample('config')), useUIStore.subscribe(() => sample('ui'))];
      const Harness = () => {
        ready = useOpenCodeReadiness().isReady;
        const directory = useDirectoryStore((state) => state.currentDirectory);
        React.useLayoutEffect(() => sample('commit'));
        return React.createElement(SyncProvider, { sdk, directory, children: React.createElement(ModelControls) });
      };
      cleanup = async () => {
        observer.disconnect(); unsubscribers.forEach((unsubscribe) => unsubscribe());
        await React.act(async () => root.unmount()); registerRuntimeAPIs(null);
      };
      await React.act(async () => root.render(React.createElement(RuntimeAPIProvider, { apis,
        children: React.createElement(I18nProvider, { children: React.createElement(Harness) }) })));
      sample('baseline');
      expect(ready).toBe(true);
      expect(useConfigStore.getState().providers[0]?.models[0]?.name).toBe('Smarty E2E');
      expect(useProjectsStore.getState().activeProjectId).toBe(project.id);
      expect(useUIStore.getState().isModelSelectorOpen).toBe(false);
      const trigger = document.querySelector<HTMLElement>('.model-controls__model-trigger');
      if (!trigger?.querySelector('.marquee-text')) throw new Error('Stock ready trigger is absent');
      await React.act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      });
      sample('opened');
      expect(useUIStore.getState().isModelSelectorOpen).toBe(true);
      expect(search()?.isConnected).toBe(true);
      await React.act(async () => { sample('before-reconciliation'); reconcile(arm === 'HOME' ? home.id : project.id); });
      sample('after-reconciliation');
      expect(useDirectoryStore.getState().currentDirectory).toBe(arm === 'HOME' ? HOME : PROJECT);
      expect(useConfigStore.getState().activeDirectoryKey).toBe(arm === 'HOME' ? HOME : PROJECT);
      const input = search();
      if (input?.isConnected && !input.disabled && !input.readOnly) await React.act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Smarty E2E');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      sample('single-input');
      expect(denied).toEqual([]);
      const fillable = search()?.isConnected && search()?.value === 'Smarty E2E';
      if (arm === 'PROJECT') expect(fillable).toBe(true);
      outcome = fillable ? 'search-remains-fillable' : 'search-not-fillable';
    } finally {
      try { await cleanup(); } finally {
        await closeLoader(); rmSync(transient, { recursive: true, force: true });
      }
      console.log(MARKER + JSON.stringify({ arm, outcome, requests, denied, samples: samples.map((item) => JSON.parse(item)) }));
      fetch.mockRestore();
      await win.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }, 90_000);
}
