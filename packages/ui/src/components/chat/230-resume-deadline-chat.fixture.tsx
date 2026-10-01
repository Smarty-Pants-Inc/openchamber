// Derived from 365-mounted-chat.fixture.tsx, OpenChamber contributors, MIT.
// Import its unchanged framework leaf stubs and private-network guard. Parent, banner, hooks, stores,
// SDK, runtimeFetch and SessionMessageLoader remain real; this fixture only adds raw HTTP gates and remount.
import { ended } from './365-mounted-chat.fixture';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRoot } from 'react-dom/client';
import { nativeComposerDom } from './composer/submit/__tests__/nativeComposer-dom';
import { deadlineHttp, target, type DeadlineReceipt } from './230-resume-deadline-http.fixture';
const { opencodeClient, createRuntimeOpencodeClient } = await import('@/lib/opencode/client');
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
export const CONTINUE = 'Continue in a new Pi', CHECK = 'Check again';
export { target, resume };
export async function deadlineChat(historyReadTimeoutMs?: number) {
  const http = await deadlineHttp(), dom = nativeComposerDom(), resolver = getRuntimeUrlResolver();
  const initialSession = useSessionUIStore.getState(), initialGlobal = useGlobalSessionsStore.getState();
  const initialProjects = useProjectsStore.getState(), initialUI = useUIStore.getState(), initialAuth = useAuthSessionStore.getState();
  const runtimeKey = getRuntimeKey(), base = opencodeClient.getBaseUrl();
  http.controls.session = () => Response.json(ended);
  switchRuntimeEndpoint({ apiBaseUrl: http.base, runtimeKey: `deadline-${crypto.randomUUID()}` });
  configureRuntimeUrlResolver({ apiBaseUrl: http.base }); opencodeClient.reconnectToRuntimeBaseUrl();
  // Existing SDK timeout injection isolates the Continue observer from the independent loader read's own cap.
  const sdk = historyReadTimeoutMs === undefined ? opencodeClient.getSdkClient()
    : createRuntimeOpencodeClient({ baseUrl: `${http.base}/api`, directory: target.directory, requestTimeoutMs: historyReadTimeoutMs });
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
  setImperativeSessionMessageLoader(loader); setSyncRefs(sdk, children, target.directory); resume.resetContinueForPage();
  const store = children.ensureChild(target.directory, { bootstrap: false });
  store.getState().patch({ session: [ended], session_status: { [target.sessionID]: { type: 'idle' } } });
  useGlobalSessionsStore.getState().upsertSession(ended);
  useSessionUIStore.setState(state => ({ currentSessionId: target.sessionID, currentSessionDirectory: target.directory,
    newSessionDraft: { ...state.newSessionDraft, open: false } }));
  useProjectsStore.setState({ projects: [{ id: 'project', path: target.directory }], activeProjectId: 'project' });
  useUIStore.setState({ isMobile: true, isExpandedInput: false, workStatusPanelEnabled: false });
  const System = globals.__openchamber_sync_context__, Runtime = globals.__openchamber_sync_runtime_context__;
  if (!System || !Runtime) throw new Error('Actual sync context seam missing');
  const value: RuntimeValue = { childStores: children, messageLoader: loader, sdk, runtimeKey: getRuntimeKey(),
    currentDirectory: { get: () => target.directory, subscribe: () => () => {} } };
  let root = createRoot(dom.container), status: import('@/sync/native-session-resume').ContinueStatus | undefined;
  function Status() { status = resume.useContinueStatus(target.sessionID, target.directory); return null; }
  const render = () => root.render(<I18nProvider><System.Provider value={{ ...value, directory: target.directory }}>
    <Runtime.Provider value={value}><ChatContainer autoOpenDraft={false} /><Status /></Runtime.Provider>
  </System.Provider></I18nProvider>);
  await act(async () => render());
  const observed = (queue: { take: () => Promise<DeadlineReceipt> }) => ({ take: async () => {
    let receipt: DeadlineReceipt | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await act(async () => { receipt = await Promise.race([queue.take(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Private HTTP receipt missing within 2s: ${JSON.stringify({
        status, snapshot: loader.getSnapshot(target), requests: http.requests.map(request => ({
          method: request.method, path: request.url.pathname, responded: request.responded })),
      })}`)), 2000);
    })]); }); } finally { clearTimeout(timer); }
    if (!receipt) throw new Error('Private HTTP receipt missing'); return receipt;
  } });
  const settle = async (matches: () => boolean) => {
    for (let turn = 0; turn < 200 && !matches(); turn++) await act(async () => { await sleep(5); });
    if (!matches()) throw new Error(`Expected mounted state not observed within 1s: ${JSON.stringify({
      status, snapshot: loader.getSnapshot(target), requests: http.requests.map(request => ({
        method: request.method, path: request.url.pathname, responded: request.responded })),
    })}`);
  };
  return { ...http, page: observed(http.page), post: observed(http.post), list: observed(http.list), read: observed(http.read), health: observed(http.health),
    dom, loader, children, status: () => status, settle,
    buttons: () => [...dom.container.querySelectorAll('button')].map(button => button.textContent),
    banner: () => dom.container.querySelector('[data-testid="fleet-view-only"]'),
    composer: () => dom.container.querySelector('[data-testid="fixture-composer"]'),
    click: async (label: string) => { await act(async () => {
      const button = [...dom.container.querySelectorAll('button')].find(button => button.textContent === label);
      if (!button) throw new Error(`Actual button missing: ${label}`); button.click(); await sleep(0);
    }); },
    rowUnavailable: async () => {
      // A ready operation does not itself change the ended listing. Publish the next authoritative session GET
      // through the actual stores, as the enrollment/catalog channel does, before accepting its writable page.
      http.controls.session = () => Response.json({ ...ended, herdrState: 'unknown' });
      const row = await opencodeClient.getSession(target.sessionID, target.directory);
      await act(async () => { store.getState().patch({ session: [row] }); useGlobalSessionsStore.getState().upsertSession(row); });
    },
    waitDeadline: async () => { await act(async () => { await sleep(77_000); }); },
    remount: async () => { await act(async () => { root.unmount(); root = createRoot(dom.container); render(); }); },
    close: async () => {
      await act(async () => { root.unmount(); await http.close(); });
      setImperativeSessionMessageLoader(null); loader.dispose(); children.disposeAll(); resume.resetContinueForPage();
      useSessionUIStore.setState(initialSession, true); useGlobalSessionsStore.setState(initialGlobal, true);
      useProjectsStore.setState(initialProjects, true); useUIStore.setState(initialUI, true); useAuthSessionStore.setState(initialAuth, true);
      switchRuntimeEndpoint({ apiBaseUrl: base, runtimeKey }); setRuntimeUrlResolver(resolver); opencodeClient.reconnectToRuntimeBaseUrl();
      await dom.restore();
    } };
}
