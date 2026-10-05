import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import { SyncProvider, useSyncRuntime } from './sync-context';
import { getSyncChildStores, setSyncRefs } from './sync-refs';
import { ChildStoreManager } from './child-store';
import { useSelectedSessionOwner } from './selected-session-owner';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useConfigStore } from '@/stores/useConfigStore';

const A = '/cold/a', B = '/cold/b', id = 'cold-stock';
const row = (directory: string, ended = false): Session => ({ id, directory, slug: id, projectID: 'fixture', title: 'fixture', version: '1',
  time: { created: 1, updated: 1 }, ...(ended ? { nativeRuntime: 'ordinary', herdrState: 'ended', herdrPaneLive: false } : {}) });

// This first mount must run in its own Bun process: no test-ref preseed can stand in for provider publication.
test('cold native provider owns subscription, warm/StrictMode mounts and scoped cleanup', async () => {
  expect(() => getSyncChildStores()).toThrow('not initialized');
  const win = new Window({ url: 'https://cold.invalid' });
  const values = { window: win, document: win.document, navigator: win.navigator, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.createElement('div'));
  const originalFetch = globalThis.fetch;
  const initialProjects = useProjectsStore.getState(), initialUI = useSessionUIStore.getState();
  const initialGlobal = useGlobalSessionsStore.getState(), initialConfig = useConfigStore.getState();
  const requests: string[] = [];
  const transport: typeof fetch = async (input) => {
    const request = new Request(input), path = new URL(request.url).pathname;
    requests.push(path);
    if (path.endsWith('/global/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path.endsWith('/path')) return Response.json({ home: '/home', directory: A, worktree: A, state: '', config: '' });
    if (path.endsWith('/project/current')) return Response.json({ id: 'fixture', worktree: A });
    if (path.endsWith('/auth/url-token')) return Response.json({ token: 'fixture', expiresAt: Date.now() + 60000 });
    return Response.json(path.endsWith('/config') || path.endsWith('/session/status') || path.endsWith('/mcp') ? {} : []);
  };
  globalThis.fetch = transport;
  const sdk = createOpencodeClient({ baseUrl: 'https://cold.invalid', fetch: transport });
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }] });
  useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: A, selectedManagedOwner: null });
  useGlobalSessionsStore.setState({ entityById: new Map() });
  let runtime: ReturnType<typeof useSyncRuntime> | undefined;
  let directory = A, visible = true, strict = false, seen = '', renders = 0;
  const Probe = () => {
    runtime = useSyncRuntime();
    const owner = useSelectedSessionOwner(id, directory, true);
    seen = owner?.status ?? 'stock'; renders += 1;
    return null;
  };
  const render = () => act(async () => {
    const content = <SyncProvider sdk={sdk} directory={directory}>{visible ? <Probe /> : null}</SyncProvider>;
    root.render(strict ? <React.StrictMode>{content}</React.StrictMode> : content);
  });
  const unrelated = new ChildStoreManager();
  try {
    await render();
    if (!runtime) throw new Error('Native provider did not publish context');
    const provider = runtime;
    expect(getSyncChildStores()).toBe(provider.childStores);
    const source = provider.childStores.getChild(A);
    if (!source) throw new Error('Selected context child missing');
    expect(provider.childStores.pinned(A)).toBe(true);
    expect(seen).toBe('stock');
    expect(requests.filter(path => path.endsWith(`/session/${id}`))).toEqual([]);
    // An unrelated imperative owner must not select the hook's snapshot or subscription.
    unrelated.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)] });
    setSyncRefs(sdk, unrelated, A);
    await act(async () => source.setState({ session: [row(A)] }));
    expect(seen).toBe('stock');
    const before = renders;
    await act(async () => unrelated.getChild(A)?.setState({ session: [] }));
    expect(renders).toBe(before);
    // Unavailable catalog keeps the scoped observation checking without granting an imperative operation.
    await act(async () => { useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }); source.setState({ session: [row(A, true)] }); });
    expect(seen).toBe('checking');
    await act(async () => source.setState({ session: [row(A)] }));
    expect(seen).toBe('stock');
    directory = B; await render();
    expect(provider.childStores.pinned(A)).toBe(false);
    expect(provider.childStores.pinned(B)).toBe(true);
    const afterSwitch = renders;
    await act(async () => source.setState({ session: [row(A, true)] }));
    expect(renders).toBe(afterSwitch);
    visible = false; await render();
    expect(provider.childStores.pinned(B)).toBe(false);
    directory = ''; visible = true; await render();
    expect(provider.childStores.children.has('')).toBe(false);
    expect(provider.childStores.pinned(B)).toBe(false);
    strict = true; directory = B; await render();
    if (!runtime) throw new Error('StrictMode provider did not mount');
    const replacement = runtime;
    expect(replacement.childStores).not.toBe(provider.childStores);
    expect(replacement.childStores.pinned(B)).toBe(true);
    expect(seen).toBe('stock');
    const afterReplacement = renders;
    await act(async () => source.setState({ session: [row(A)] }));
    expect(renders).toBe(afterReplacement);
    await act(async () => root.unmount());
    expect(replacement.childStores.pinned(B)).toBe(false);
    const afterUnmount = renders;
    await act(async () => replacement.childStores.getChild(B)?.setState({ session: [row(B, true)] }));
    expect(renders).toBe(afterUnmount);
    expect(requests.filter(path => path.endsWith(`/session/${id}`))).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    unrelated.disposeAll();
    useProjectsStore.setState(initialProjects, true); useSessionUIStore.setState(initialUI, true);
    useGlobalSessionsStore.setState(initialGlobal, true); useConfigStore.setState(initialConfig, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await win.happyDOM.close();
  }
});
