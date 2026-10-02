import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { useProjectsStore } from '../stores/useProjectsStore';
import { applyFleetSessionStatuses, getSessionStatusEventVersion, applyGlobalSessionStatusEvents, applyGlobalSessionStatusSnapshot, replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from './global-session-status';
import { forgetRowNativeStatus, liveHerdrState, rowNativeStatus } from '../lib/herdrSession';
import { recordStatusUnavailable, useStatusUnavailable, useStatusUnavailableStore } from './status-unavailable';
import { SyncProvider, useGlobalSessionStatus, useSyncRuntime } from './sync-context';
// smarty-code#539: `smarty.unknown` projects retain statuses for one poll, then clear without their own failing read.
const unknownB = { 'smarty.unknown': [{ directory: '/b/', status: 503 }] };
async function withFleet(fleet: () => Response, run: (reads: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(new Request(input, init).url), path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/session/status') {
      const directory = url.searchParams.get('directory');
      reads.push(directory ?? `fleet${url.searchParams.get('unknown') === '1' ? '?unknown=1' : ''}`);
      return directory === '/b' ? new Response(null, { status: 503 }) : directory ? Response.json({ ses_a: { type: 'busy' } }) : fleet();
    }
    return originalFetch(input, init);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: `status-unavailable-${Math.random()}`, clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  try { await run(reads); } finally { globalThis.fetch = originalFetch; recordStatusUnavailable([]); }
}
test('the fleet read asks for unknown projects, records them and still returns the healthy statuses', async () => {
  await withFleet(() => Response.json({ ses_a: { type: 'busy' }, ...unknownB }), async (reads) => {
    expect(await opencodeClient.getSessionStatusForDirectory(null)).toEqual({ ses_a: { type: 'busy' } });
    expect(reads).toEqual(['fleet?unknown=1']);
    expect([...useStatusUnavailableStore.getState().directories]).toEqual(['/b']);
  });
});
test('a later fleet read replaces the set, a malformed marker counts as none, and a failed read changes nothing', async () => {
  let answer = () => Response.json({ ses_a: { type: 'busy' }, ...unknownB });
  await withFleet(() => answer(), async () => {
    await opencodeClient.getSessionStatusForDirectory(null);
    answer = () => new Response(null, { status: 503 });
    expect(await opencodeClient.getSessionStatusForDirectory(null)).toBeNull();
    expect([...useStatusUnavailableStore.getState().directories]).toEqual(['/b']);
    answer = () => Response.json({ ses_a: { type: 'busy' }, 'smarty.unknown': [{ directory: 7 }] });
    expect(await opencodeClient.getSessionStatusForDirectory(null)).toEqual({ ses_a: { type: 'busy' } });
    expect(useStatusUnavailableStore.getState().directories.size).toBe(0);
  });
});
test('outage invalidation matches snapshot coverage, excluding held and foreign ordinary history', () => {
  const prior = useGlobalSessionStatusStore.getState().statusById;
  const indexed = new Map([['covered', '/b'], ['alias', '/alias'], ['held', '/b'], ['foreign', '/other'], ['unrelated', '/other']]
    .map(([id, directory]) => [id, { directory, status: { type: 'busy' as const, ordinary: id === 'foreign' } }]));
  try {
    replaceGlobalSessionStatusById(indexed);
    for (const id of [...indexed.keys(), 'missing']) rowNativeStatus(id, 'working', 'busy');
    applyGlobalSessionStatusSnapshot('/b/', {}, ['alias', 'foreign', 'missing'], new Set(['held']), ids => {
      expect(new Set(ids)).toEqual(new Set(['covered', 'alias', 'missing']));
      expect(useGlobalSessionStatusStore.getState().statusById).toBe(indexed); // Before publication.
      forgetRowNativeStatus(ids);
    });
    expect([...useGlobalSessionStatusStore.getState().statusById.keys()]).toEqual(['held', 'foreign', 'unrelated']);
    for (const id of ['covered', 'alias', 'missing']) expect(rowNativeStatus(id, 'working', undefined, true).native).toBeUndefined();
    for (const id of ['held', 'foreign', 'unrelated']) {
      applyGlobalSessionStatusEvents(indexed.get(id)!.directory, [{ id: `idle-${id}`, type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } }]);
      expect(liveHerdrState('working', rowNativeStatus(id, 'working', undefined, true).native)).toBe('done');
    }
  } finally { replaceGlobalSessionStatusById(prior); }
});
const connected = new TextEncoder().encode(`data: ${JSON.stringify({ directory: '/a', payload: { id: 'evt', type: 'server.connected', properties: {} } })}\n\n`);
for (const visibility of ['mounted', 'hidden'] as const) {
test(`registered watchdog (${visibility} rows): outage/recovery falls back to Herdr; real busy and idle still win`, async () => {
  let unknown = false;
  await withFleet(() => Response.json({ ses_a: { type: 'busy' }, ...(unknown ? unknownB : {}) }), async (reads) => {
    const dom = installHookTestDom();
    Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
    const root = createRoot(dom.container);
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname.replace(/^\/api/, '');
      if (path === '/global/event') {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(connected); } }),
          { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
      if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
      if (path === '/global/config') return Response.json({});
      if (path === '/session/status') return fixtureFetch(input, init);
      return Response.json([]);
    };
    const initialProjects = useProjectsStore.getState();
    useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
    let runtime!: ReturnType<typeof useSyncRuntime>;
    const observed = new Map<string, ReturnType<typeof liveHerdrState>>();
    let sampled: ReturnType<typeof liveHerdrState> = 'working';
    const Row = ({ id }: { id: string }) => {
      const entry = useGlobalSessionStatus(id);
      const unavailable = useStatusUnavailable('/b');
      const rendered = React.useRef(false);
      const native = rowNativeStatus(id, sampled, entry?.type, !rendered.current, unavailable);
      rendered.current = true;
      const state = liveHerdrState(sampled, native.native, native.herdrIsNewer);
      React.useLayoutEffect(() => {
        observed.set(id, state);
        return () => { observed.delete(id); };
      });
      return null;
    };
    const Selected = () => { runtime = useSyncRuntime(); return null; };
    const render = (generation = 0, visible = true) => act(async () => root.render(
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/a"><Selected />
        {visible && <>{['ses_b', 'ses_retry', 'ses_global_only'].map(id => <Row key={`${id}-${generation}`} id={id} />)}</>}
      </SyncProvider>));
    const expectRows = (state: string) => ['ses_b', 'ses_retry', 'ses_global_only'].forEach(id => expect(observed.get(id)).toBe(state));
    const status = (directory: string, id: string) => runtime.childStores.getChild(directory)?.getState().session_status[id]?.type;
    try {
      await render();
      await act(async () => {
        useProjectsStore.setState({ managedCatalogAdmitted: true });
        for (const [directory, id] of [['/a', 'ses_a'], ['/b', 'ses_b']] as const) {
          runtime.childStores.ensureChild(directory, { bootstrap: false }).setState({ session_status: { [id]: { type: 'busy' } } });
          applyGlobalSessionStatusSnapshot(directory, { [id]: { type: 'busy' } });
        }
        const retry = { type: 'retry', attempt: 1, message: 'retry', next: Date.now() + 60_000 } as const;
        runtime.childStores.getChild('/b')?.setState(state => ({ session_status: { ...state.session_status, ses_retry: retry } }));
        applyGlobalSessionStatusSnapshot('/b', { ses_b: { type: 'busy' }, ses_retry: retry });
        applyFleetSessionStatuses([{ id: 'ses_global_only', directory: '/b' }], { ses_global_only: { type: 'busy' } },
          new Map([['ses_global_only', getSessionStatusEventVersion('ses_global_only')]]));
      });
      expectRows('working');
      await act(async () => new Promise(done => setTimeout(done, 300)));
      expect(useStatusUnavailableStore.getState().directories.size).toBe(0);
      expectRows('working'); // Seed native history before all rows are hidden.
      expect(status('/b', 'ses_global_only')).toBeUndefined(); // Managed refresh seeds only the global index.
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_global_only')).toBe(true);
      if (visibility === 'hidden') { await render(0, false); expect(observed.size).toBe(0); }
      unknown = true;
      reads.length = 0;
      await act(async () => new Promise(done => setTimeout(done, 5_200)));
      expect(reads).toEqual(['fleet?unknown=1']); // First unknown poll retains native authority; no /b read.
      expect(status('/b', 'ses_b')).toBe('busy');
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_b')).toBe(true);
      expect(status('/b', 'ses_retry')).toBe('retry');
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_global_only')).toBe(true);
      if (visibility === 'hidden') expect(observed.size).toBe(0);
      else expectRows('working');
      await act(async () => new Promise(done => setTimeout(done, 5_000)));
      expect(reads.filter(read => read === '/b')).toEqual([]);
      expect(status('/b', 'ses_b')).toBe('idle');
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_b')).toBe(false);
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_retry')).toBe(false);
      expect(status('/b', 'ses_retry')).toBe('idle');
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_global_only')).toBe(false);
      if (visibility === 'hidden') expect(observed.size).toBe(0);
      else {
        expectRows('working'); // Clearing an unavailable native entry is NOT a completed turn.
        await render(1); // Collapse/reopen during the outage: #484's remount must keep the fallback.
        expectRows('working');
      }
      unknown = false;
      await act(async () => new Promise(done => setTimeout(done, 5_200)));
      expect(useStatusUnavailableStore.getState().directories.size).toBe(0);
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_b')).toBe(false);
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_retry')).toBe(false);
      if (visibility === 'hidden') {
        expect(observed.size).toBe(0); // Neither row rendered during either unknown poll or healthy recovery.
        await render(1);
      }
      expectRows('working'); // Recovery with no native entry is not evidence that the turn completed.
      sampled = 'done';
      await render(1);
      expectRows('done');
      if (visibility === 'hidden') await render(1, false);
      await act(async () => applyGlobalSessionStatusEvents('/b', ['ses_b', 'ses_retry', 'ses_global_only'].map(sessionID => ({
        id: `busy-${sessionID}`, type: 'session.status', properties: { sessionID, status: { type: 'busy' } },
      }))));
      if (visibility === 'hidden') { expect(observed.size).toBe(0); await render(2); }
      expectRows('working'); // Recovered current busy beats stale Herdr done, including on remount.
      sampled = 'working';
      await render(2);
      if (visibility === 'hidden') await render(2, false);
      await act(async () => applyGlobalSessionStatusEvents('/b', ['ses_b', 'ses_retry', 'ses_global_only'].map(sessionID => ({
        id: `idle-${sessionID}`, type: 'session.status', properties: { sessionID, status: { type: 'idle' } },
      }))));
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_b')).toBe(false);
      if (visibility === 'hidden') { expect(observed.size).toBe(0); await render(3); }
      expectRows('done'); // Real idle while hidden still finishes on remount, with stale Herdr working.
      expect(status('/a', 'ses_a')).toBe('busy');
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses_a')).toBe(true);
    } finally {
      await act(async () => root.unmount());
      useProjectsStore.setState(initialProjects, true);
      dom.restore();
    }
  });
}, 30_000);
}
