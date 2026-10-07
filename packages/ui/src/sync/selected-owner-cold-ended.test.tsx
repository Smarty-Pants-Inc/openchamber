import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import { SyncProvider, useSyncRuntime } from './sync-context';
import { getDirectoryState, getSyncChildStores } from './sync-refs';
import { persistSessions } from './persist-cache';
import { useSelectedSessionOwner } from './selected-session-owner';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useConfigStore } from '@/stores/useConfigStore';

const directory = '/cold/ended-owner', sessionID = 'persisted-ended';
const row: Session = { id: sessionID, directory, slug: sessionID, projectID: 'cold', title: 'Ended', version: '1', time: { created: 1, updated: 1 },
  ...{ nativeRuntime: 'ordinary', herdrState: 'ended', herdrPaneLive: false } };

test('admitted-ready cold persisted ended selection starts its owner check before parent refs without throwing', async () => {
  expect(() => getSyncChildStores()).toThrow('not initialized');
  const win = new Window({ url: 'https://cold-ended.invalid' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const originalFetch = globalThis.fetch;
  const projects = useProjectsStore.getState(), selection = useSessionUIStore.getState(), global = useGlobalSessionsStore.getState(), config = useConfigStore.getState();
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    requests.push(request);
    if (path.endsWith(`/session/${sessionID}`)) return Response.json(row);
    if (path.endsWith('/global/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path.endsWith('/path')) return Response.json({ home: '/home', directory, worktree: directory, state: '', config: '' });
    if (path.endsWith('/project/current')) return Response.json({ id: 'cold', worktree: directory });
    if (path.endsWith('/project')) return Response.json([{ id: 'cold', worktree: directory }], { headers: { 'x-smarty-code-catalog': 'managed-v1' } });
    if (path.endsWith('/auth/url-token')) return Response.json({ token: 'fixture', expiresAt: Date.now() + 60000 });
    if (path.endsWith('/session')) return Response.json([row]);
    return Response.json(path.endsWith('/config') || path.endsWith('/session/status') || path.endsWith('/mcp') ? {} : []);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://cold-ended.invalid', runtimeKey: 'cold-ended', clientToken: 'fixture' });
  opencodeClient.setDirectory(directory);
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'cold', worktree: directory }] });
  useGlobalSessionsStore.setState({ entityById: new Map([[sessionID, row]]) });
  useSessionUIStore.setState({ currentSessionId: sessionID, currentSessionDirectory: directory, selectedManagedOwner: null });
  persistSessions(directory, [row]); // Native persisted-row input, never imperative-ref preseeding.
  let beforePublication = false, seen = '';
  let runtime: ReturnType<typeof useSyncRuntime> | undefined;
  const Probe = () => {
    runtime = useSyncRuntime();
    const owner = useSelectedSessionOwner(sessionID, directory, true);
    seen = owner?.status ?? 'stock';
    React.useEffect(() => { beforePublication = getDirectoryState(directory) === undefined; }, []);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory={directory}><Probe /></SyncProvider>));
    for (let turn = 0; turn < 100 && seen !== 'ended'; turn++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(beforePublication).toBe(true);
    expect(seen).toBe('ended');
    expect(runtime?.childStores).toBe(getSyncChildStores());
    const detail = requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${sessionID}`));
    expect(detail).toHaveLength(1);
    expect(new URL(detail[0].url).searchParams.has('directory')).toBe(false);
    expect(detail[0].headers.has('x-opencode-directory')).toBe(false);
    expect(requests.filter(request => new URL(request.url).pathname.startsWith('/api/') && request.method !== 'GET')).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    await new Promise(resolve => setTimeout(resolve, 5));
    useProjectsStore.setState(projects, true); useSessionUIStore.setState(selection, true);
    useGlobalSessionsStore.setState(global, true); useConfigStore.setState(config, true);
    globalThis.fetch = originalFetch; opencodeClient.setDirectory(undefined);
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await win.happyDOM.close();
  }
});
