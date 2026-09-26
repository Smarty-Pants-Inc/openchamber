import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { useProjectsStore } from '../stores/useProjectsStore';
import { SyncProvider, useSyncRuntime } from './sync-context';

// smarty-code G13 (Release 3.30 HAR, smarty-dev#777): the busy-session watchdog read /session/status?directory= for
// every directory with an active session every 5 s: ten busy projects were 120 reads a minute. A managed gateway's
// fleet-wide /session/status answers them all: one read per tick. Stock keeps its per-directory reads.
const connected = new TextEncoder().encode(
  `data: ${JSON.stringify({ directory: '/a', payload: { id: 'evt', type: 'server.connected', properties: {} } })}\n\n`);

async function oneWatchdogTick(managed: boolean) {
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
    if (path === '/session/status') {
      reads.push(url.searchParams.get('directory') ?? 'fleet');
      return Response.json({ ses_a: { type: 'busy' }, ses_b: { type: 'busy' } });
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config') return Response.json({});
    return Response.json([]);
  };
  const initialProjects = useProjectsStore.getState();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: `fleet-status-${managed}`, clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="/a"><Selected /></SyncProvider>));
    useProjectsStore.setState({ managedCatalogAdmitted: managed });
    for (const [directory, id] of [['/a', 'ses_a'], ['/b', 'ses_b']] as const) {
      runtime.childStores.ensureChild(directory, { bootstrap: false }).setState({ session_status: { [id]: { type: 'busy' } } });
    }
    await act(async () => new Promise(done => setTimeout(done, 300)));
    reads.length = 0; // Startup reads aside: count one watchdog tick (every 5 s).
    await act(async () => new Promise(done => setTimeout(done, 5_200)));
    return reads.slice();
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState(initialProjects, true);
    globalThis.fetch = originalFetch;
    dom.restore();
  }
}

test('a managed catalog polls busy sessions with one fleet-wide status read per tick', async () => {
  const reads = await oneWatchdogTick(true);
  expect(reads.filter(read => read === 'fleet').length).toBe(1);
  expect(reads.filter(read => read !== 'fleet')).toEqual([]);
}, 15_000);

test('stock keeps one status read per directory with a busy session', async () => {
  const reads = await oneWatchdogTick(false);
  expect(reads.filter(read => read !== 'fleet').sort()).toEqual(['/a', '/b']);
}, 15_000);
