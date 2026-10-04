import React, { act } from 'react';
import { mock, spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ContinueStatus } from '@/sync/native-session-resume';
import { nativeComposerDom } from './composer/submit/__tests__/nativeComposer-dom';
import { mountedHttp, target } from './365-mounted-http.fixture';

// Framework-only leaves: no virtual timeline, composer editor, or work-status panels.
// Actual parent, banner, Continue state, all sync hooks/stores, loader, SDK and HTTP remain real.
mock.module('./MessageList', () => ({ default: () => <div data-testid="fixture-timeline" /> }));
mock.module('./ChatInput', () => ({ ChatInput: () => <div data-testid="fixture-composer" /> }));
mock.module('./work-status/WorkStatusPanel', () => ({ WorkStatusPanel: () => null }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => null, preloadProviderLogos: () => undefined }));
mock.module('./markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:unused-worker' }));
const nativeFetch = globalThis.fetch;
spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== '127.0.0.1') throw new Error('Mounted fixture refuses nonprivate network');
  return nativeFetch(input, init);
});
const bootstrapHttp = await mountedHttp(), bootstrap = nativeComposerDom();
Object.defineProperty(bootstrap.window, '__OPENCHAMBER_API_BASE_URL__', { value: bootstrapHttp.base, configurable: true });
const { createRoot } = await import('react-dom/client');
const { opencodeClient } = await import('@/lib/opencode/client');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader, setImperativeSessionMessageLoader } = await import('@/sync/session-message-loader');
const resume = await import('@/sync/native-session-resume');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { setSyncRefs } = await import('@/sync/sync-refs');
const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { I18nProvider } = await import('@/lib/i18n');
const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
const { ChatContainer } = await import('./ChatContainer');
import type { useSyncRuntime } from '@/sync/sync-context';
type RuntimeValue = ReturnType<typeof useSyncRuntime>;
const globals: typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(RuntimeValue & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<RuntimeValue | null>;
} = globalThis;
await sleep(0); await bootstrapHttp.close(); await bootstrap.restore();
export const ended: Session & { herdrState: string; nativeRuntime: string; ordinary: null; ordinaryCodeMade: boolean } = {
  id: target.sessionID, slug: 'ended', projectID: 'project', directory: target.directory, title: 'Ended Pi',
  version: '1', time: { created: 1, updated: 1 }, herdrState: 'ended', nativeRuntime: 'ordinary', ordinary: null, ordinaryCodeMade: true,
};

type NativeRow = Session & { herdrState?: string; ordinaryCodeMade?: boolean; herdrNoIdentity?: boolean };
export async function mountedChat(options: { local?: NativeRow; global?: NativeRow; supported?: boolean;
  health?: () => Response | Promise<Response> } = {}) {
  const http = await mountedHttp(), dom = nativeComposerDom(), resolver = getRuntimeUrlResolver();
  const initialSession = useSessionUIStore.getState(), initialGlobal = useGlobalSessionsStore.getState();
  const initialProjects = useProjectsStore.getState(), initialUI = useUIStore.getState(), initialAuth = useAuthSessionStore.getState();
  const runtimeKey = getRuntimeKey(), base = opencodeClient.getBaseUrl();
  http.controls.session = () => Response.json(options.local ?? ended);
  http.controls.health = options.health ?? (() => Response.json({ healthy: true, capabilities: options.supported === false ? {} : { ordinaryResume: 1 } }));
  switchRuntimeEndpoint({ apiBaseUrl: http.base, runtimeKey: `mounted-${crypto.randomUUID()}` });
  configureRuntimeUrlResolver({ apiBaseUrl: http.base }); opencodeClient.reconnectToRuntimeBaseUrl();
  const sdk = opencodeClient.getSdkClient(), children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
  setImperativeSessionMessageLoader(loader); setSyncRefs(sdk, children, target.directory); resume.resetContinueForPage();
  const store = children.ensureChild(target.directory, { bootstrap: false });
  store.getState().patch({ session: [options.local ?? ended], session_status: { [target.sessionID]: { type: 'idle' } } });
  useGlobalSessionsStore.getState().upsertSession(options.global ?? options.local ?? ended);
  useSessionUIStore.setState(state => ({ currentSessionId: target.sessionID, currentSessionDirectory: target.directory,
    newSessionDraft: { ...state.newSessionDraft, open: false } }));
  useProjectsStore.setState({ projects: [{ id: 'project', path: target.directory }], activeProjectId: 'project' });
  useUIStore.setState({ isMobile: true, isExpandedInput: false, workStatusPanelEnabled: false });
  const System = globals.__openchamber_sync_context__, Runtime = globals.__openchamber_sync_runtime_context__;
  if (!System || !Runtime) throw new Error('Actual sync context seam missing');
  let value: RuntimeValue = { childStores: children, messageLoader: loader, sdk, runtimeKey: getRuntimeKey(),
    currentDirectory: { get: () => target.directory, subscribe: () => () => {} } };
  const root = createRoot(dom.container);
  let status: ContinueStatus | undefined;
  function Status() { status = resume.useContinueStatus(target.sessionID, target.directory); return null; }
  const render = () => root.render(<I18nProvider><System.Provider value={{ ...value, directory: target.directory }}>
    <Runtime.Provider value={value}><ChatContainer autoOpenDraft={false} /><Status /></Runtime.Provider>
  </System.Provider></I18nProvider>);
  await act(async () => render());
  const observed = (queue: { take: () => Promise<{ reply: (response: Response) => void }> }) => ({ take: async () => {
    let receipt: Awaited<ReturnType<typeof queue.take>> | undefined;
    await act(async () => { receipt = await queue.take(); });
    if (!receipt) throw new Error('Private HTTP receipt missing'); return receipt;
  } });
  return { ...http, page: observed(http.page), post: observed(http.post), list: observed(http.list), health: observed(http.health),
    dom, loader, children, status: () => status, resume,
    buttons: () => [...dom.container.querySelectorAll('button')].map(button => button.textContent),
    text: () => dom.container.textContent ?? '',
    banner: () => dom.container.querySelector('[data-testid="fleet-view-only"]'),
    click: async (label: string) => { await act(async () => {
      const button = [...dom.container.querySelectorAll('button')].find(button => button.textContent === label);
      if (!button) throw new Error(`Actual button missing: ${label}`); button.click(); await sleep(0);
    }); },
    row: async (local: NativeRow, global: NativeRow = local) => { await act(async () => {
      http.controls.session = () => Response.json(local);
      store.getState().patch({ session: [local] }); useGlobalSessionsStore.getState().upsertSession(global);
    }); },
    select: async (local: NativeRow) => { await act(async () => {
      http.controls.session = () => Response.json(local);
      children.ensureChild(local.directory ?? target.directory, { bootstrap: false }).getState().patch({ session: [local] });
      useGlobalSessionsStore.getState().upsertSession(local);
      useSessionUIStore.getState().setCurrentSession(local.id, local.directory);
    }); },
    // The fixture supplies the same current SDK/loader reconfiguration seam as RuntimeSyncProvider.
    rebindRuntime: async () => { await act(async () => {
      const nextSdk = opencodeClient.getSdkClient();
      loader.configure({ sdk: nextSdk, runtimeKey: value.runtimeKey });
      setSyncRefs(nextSdk, children, target.directory); value = { ...value, sdk: nextSdk }; render();
    }); },
    switchEndpoint: async (path: string) => { await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: `${http.base}${path}`, runtimeKey: value.runtimeKey });
      opencodeClient.reconnectToRuntimeBaseUrl();
      const nextSdk = opencodeClient.getSdkClient();
      loader.configure({ sdk: nextSdk, runtimeKey: value.runtimeKey });
      setSyncRefs(nextSdk, children, target.directory); value = { ...value, sdk: nextSdk }; render();
    }); },
    settle: async (matches: () => boolean) => {
      for (let turn = 0; turn < 200 && !matches(); turn++) await act(async () => { await sleep(5); });
      if (!matches()) throw new Error('Expected mounted state not observed within 1s');
    },
    render: async () => { await act(async () => render()); },
    close: async () => {
      await act(async () => { root.unmount(); await http.close(); });
      setImperativeSessionMessageLoader(null); loader.dispose(); children.disposeAll(); resume.resetContinueForPage();
      useSessionUIStore.setState(initialSession, true); useGlobalSessionsStore.setState(initialGlobal, true);
      useProjectsStore.setState(initialProjects, true); useUIStore.setState(initialUI, true); useAuthSessionStore.setState(initialAuth, true);
      switchRuntimeEndpoint({ apiBaseUrl: base, runtimeKey }); setRuntimeUrlResolver(resolver); opencodeClient.reconnectToRuntimeBaseUrl();
      await dom.restore();
    } };
}
export { target };
