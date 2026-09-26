import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { useProjectsStore } from '../stores/useProjectsStore';
import { SyncProvider, useSyncRuntime } from './sync-context';

// smarty-code G13 (Release 3.30 HAR, smarty-dev#777): the watchdog's child-session discovery read each busy directory's
// session list every 15 s (26 of the minute's requests). A managed catalog's global session list already holds the
// fleet's sessions, children included: discovery reads it instead. Stock keeps its per-directory reads.
const connected = new TextEncoder().encode(
  `data: ${JSON.stringify({ directory: '/a', payload: { id: 'evt', type: 'server.connected', properties: {} } })}\n\n`);

async function oneWatchdogTick(managed: boolean) {
  const { useGlobalSessionsStore } = await import('../stores/useGlobalSessionsStore');
  const initialGlobal = useGlobalSessionsStore.getState();
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  const root = createRoot(dom.container);
  const reads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url), path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(connected); } }),
        { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/session/status') return Response.json({ ses_a: { type: 'busy' }, ses_b: { type: 'busy' } });
    if (path === '/experimental/session' && url.searchParams.get('roots') === 'false') {
      reads.push(url.searchParams.get('directory') ?? 'fleet');
      return Response.json([]);
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config') return Response.json({});
    return Response.json([]);
  };
  const initialProjects = useProjectsStore.getState();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: `child-discovery-${managed}`, clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="/a"><Selected /></SyncProvider>));
    useProjectsStore.setState({ managedCatalogAdmitted: managed });
    // The catalog's fleet list, with a child of ses_b the directory store does not know yet.
    const row = (id: string, directory: string, parentID?: string) => ({ id, directory, projectID: 'p', slug: id, title: id, version: '1',
      time: { created: 1, updated: 1 }, ...(parentID ? { parentID } : {}) });
    useGlobalSessionsStore.getState().applySnapshot([row('ses_a', '/a'), row('ses_b', '/b'), row('ses_b_child', '/b', 'ses_b')] as never, []);
    for (const [directory, id] of [['/a', 'ses_a'], ['/b', 'ses_b']] as const) {
      runtime.childStores.ensureChild(directory, { bootstrap: false }).setState({ session_status: { [id]: { type: 'busy' } } });
    }
    await act(async () => new Promise(done => setTimeout(done, 300)));
    reads.length = 0; // Startup reads aside: count one watchdog tick (every 5 s).
    await act(async () => new Promise(done => setTimeout(done, 5_200)));
    const discovered = runtime.childStores.getChild('/b')?.getState().session.some(session => session.id === 'ses_b_child') ?? false;
    return { reads: reads.slice(), discovered };
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState(initialProjects, true);
    useGlobalSessionsStore.setState(initialGlobal, true);
    globalThis.fetch = originalFetch;
    dom.restore();
  }
}

test('a managed catalog discovers busy sessions\' children from its fleet list, with no per-directory list read', async () => {
  const { reads, discovered } = await oneWatchdogTick(true);
  expect(reads).toEqual([]);
  expect(discovered).toBe(true);
}, 15_000);

test('stock keeps one child-session list read per directory with a busy session', async () => {
  const { reads } = await oneWatchdogTick(false);
  expect(reads.filter(read => read !== 'fleet').sort()).toEqual(['/a', '/b']);
}, 15_000);
