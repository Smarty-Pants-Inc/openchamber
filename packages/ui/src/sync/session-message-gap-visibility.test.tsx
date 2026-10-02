import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { GapRow } from '../components/chat/components/GapRow';
import { createWindowQueue } from '../components/chat/lib/windowQueue';
import { opencodeClient } from '@/lib/opencode/client';
import { resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { useSessionUIStore } from './session-ui-store';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { SyncProvider, useSessionMessageLoader, useSessionMessageLoadState } from './sync-context';
import { getSyncChildStores } from './sync-refs';
import { acceptedView, deferred, directory, nativeDraftFixture, session } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const target = { directory, sessionID: session.id };
const gap = { kind: 'gap' as const, key: 'gap:0', start: 0, end: 9_950, gapStart: 0, gapEnd: 9_950, heightPx: 796_000 };

// The same subscription and stable queue as ChatContainer. Visibility and loader generations are not demand.
function MountedGap() {
  const loader = useSessionMessageLoader();
  useSessionMessageLoadState(session.id, directory);
  const loadWindow = React.useMemo(() => createWindowQueue((start, limit) => loader.loadAt(target, start, limit),
    () => useSessionUIStore.getState().currentSessionId === session.id), [loader]);
  return <GapRow gap={gap} onLoadWindow={loadWindow} />;
}

const page = (at: number, limit: number) => Response.json(Array.from({ length: limit }, (_, index) => ({
  info: { id: `m${at + index}`, sessionID: session.id, role: 'user', time: { created: at + index + 1 },
    agent: 'build', model: { providerID: 'p', modelID: 'm' } }, parts: [],
})), { headers: { 'x-smarty-ordinary-view': acceptedView, 'x-smarty-at': String(at),
  'x-smarty-total': '10000', 'x-smarty-index-epoch': 'e1' } });

for (const finish of ['foreground', 'unmount', 'navigation'] as const) {
  test(`mounted resolved gap window ${finish} after hide with unchanged geometry and healthy SSE`, async () => {
    fixture = nativeDraftFixture();
    const happy = new Window({ width: 1200, height: 800, url: 'http://synthetic.invalid/' });
    const documentEvents = new EventTarget();
    let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
    let observations = 0;
    const globals = {
      window: happy, document: happy.document, location: new URL('http://synthetic.invalid/'),
      Element: happy.Element, HTMLElement: happy.HTMLElement, HTMLIFrameElement: happy.HTMLIFrameElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      IntersectionObserver: class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersect = callback; }
        observe() { observations++; }
        disconnect() {}
      },
    };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, writable: true, value: 'visible' });
    Object.assign(document, { hasFocus: () => true, addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents) });
    const scroller = document.createElement('div');
    scroller.setAttribute('data-scrollbar', 'chat');
    document.body.appendChild(scroller);
    const box = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height,
      left: 0, right: 1200, width: 1200, height, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => box(0, 800);
    const root = createRoot(scroller);
    const streamStarted = deferred<void>();
    let heartbeat = () => {};
    let streams = 0;
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/global/event')) {
        streams++;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          heartbeat = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory,
            payload: { type: 'server.heartbeat', properties: {} } })}\n\n`));
          request.signal.addEventListener('abort', () => controller.close(), { once: true });
          heartbeat(); streamStarted.resolve();
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path.endsWith(`/session/${session.id}`)) return Response.json(session);
      return fixtureFetch(input, init);
    };
    const windowStarted = deferred<Request>();
    const windowResponse = deferred<Response>();
    let newestReads = 0, windowReads = 0, commits = 0;
    let at = 0, limit = 0;
    fixture.handlers.history = async request => {
      const url = new URL(request.url);
      const position = Number(url.searchParams.get('at'));
      const count = Number(url.searchParams.get('limit'));
      if (position < 0) { newestReads++; return page(10_000 + position, count); }
      windowReads++; at = position; limit = count;
      windowStarted.resolve(request); return windowResponse.promise;
    };
    useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: directory });
    const sdk = opencodeClient.getSdkClient();
    let stop = () => {};
    try {
      await act(async () => root.render(<SyncProvider sdk={sdk} directory="">{null}</SyncProvider>));
      const loader = getImperativeSessionMessageLoader()!;
      const store = getSyncChildStores().ensureChild(directory, { bootstrap: false });
      store.setState({ session: [session], session_status: { [session.id]: { type: 'idle' } } });
      await loader.ensure(target, { reason: 'navigation' });
      expect(loader.getSnapshot(target)).toMatchObject({ resolved: true, positions: { total: 10_000, epoch: 'e1' } });
      expect(loader.isOrdinary(target, fixture.runtimeA)).toBe(true);
      const beforeMessages = store.getState().message[session.id];
      const beforePositions = loader.getSnapshot(target).positions;
      stop = store.subscribe((state, previous) => { if (state.message[session.id] !== previous.message[session.id]) commits++; });
      await act(async () => root.render(<SyncProvider sdk={sdk} directory=""><MountedGap /></SyncProvider>));
      const node = scroller.querySelector<HTMLElement>('[data-history-gap]')!;
      node.getBoundingClientRect = () => box(-400_000, gap.heightPx);
      // One initial jump into a gap spanning the viewport. No scroll or observer event follows this demand.
      await act(async () => { intersect([{ isIntersecting: true }]); await sleep(150); });
      const request = await windowStarted.promise;
      expect(at).toBeGreaterThan(0);
      expect(at + limit).toBeLessThan(gap.end);
      expect(limit).toBe(500);
      await streamStarted.promise; await sleep(50);
      Object.assign(document, { visibilityState: 'hidden' });
      await act(async () => documentEvents.dispatchEvent(new Event('visibilitychange')));
      heartbeat(); await sleep(50);
      const detail = await opencodeClient.getScopedSdkClient(directory).session.get({ sessionID: session.id });
      expect(detail.data).toEqual(session);
      expect(store.getState().message[session.id]).toBe(beforeMessages);
      expect(loader.getSnapshot(target).positions).toBe(beforePositions);
      if (finish === 'unmount') await act(async () => root.render(<SyncProvider sdk={sdk} directory="">{null}</SyncProvider>));
      else if (finish === 'navigation') await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session', currentSessionDirectory: directory }));
      if (finish !== 'foreground') {
        expect(request.signal.aborted).toBe(true);
        expect(request.signal.reason).toMatchObject({ origin: finish === 'unmount' ? 'disposed' : 'navigation' });
      }
      Object.assign(document, { visibilityState: 'visible' });
      await act(async () => {
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        windowResponse.resolve(page(at, limit));
        // Observe materialization only, never load/refresh or requeue after the initial jump.
        if (finish === 'foreground') {
          for (let attempts = 0; attempts < 100 && !store.getState().message[session.id]?.some(message => message.id === `m${at}`); attempts++) await sleep(10);
        } else await sleep(50);
      });
      if (finish === 'foreground') {
        expect(store.getState().message[session.id]?.some(message => message.id === `m${at}`)).toBe(true);
        expect(loader.getSnapshot(target).positions?.ranges).toContainEqual({ start: at, end: at + limit });
        expect(loader.positionOf(target, `m${at}`)).toBe(at);
        expect(commits).toBe(1);
        expect(request.signal.aborted).toBe(false);
        expect(observations).toBe(1);
      } else {
        expect(store.getState().message[session.id]).toBe(beforeMessages);
        expect(commits).toBe(0);
      }
      await sleep(100);
      expect(commits).toBe(finish === 'foreground' ? 1 : 0);
      expect(windowReads).toBe(1);
      expect(newestReads).toBe(1);
      expect(streams).toBe(1);
      expect(fixture.requests.filter(request => new URL(request.url).pathname === '/api/client-error')).toEqual([]);
    } finally {
      windowResponse.resolve(page(at, limit));
      stop(); await act(async () => root.unmount()); await sleep(10);
      globalThis.fetch = fixtureFetch;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
      await happy.happyDOM.close();
    }
  }, 10_000);
}
