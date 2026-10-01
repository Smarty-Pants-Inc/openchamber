import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { opencodeClient } from '@/lib/opencode/client';
import { resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { useSessionUIStore } from './session-ui-store';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { SyncProvider } from './sync-context';
import { acceptedView, deferred, directory, nativeDraftFixture, session } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const target = { directory, sessionID: session.id };
const sentReports = () => fixture!.requests.filter(request => new URL(request.url).pathname === '/api/client-error');

// Round 1: stable detail and a healthy stream must not rescue a quiet session's canceled first read.
for (const scenario of ['healthy', 'hide-show', 'hide-show-stale'] as const) {
  test(`first history hydration ${scenario} commits once`, async () => {
    fixture = nativeDraftFixture();
    const dom = installHookTestDom();
    const documentEvents = new EventTarget();
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://synthetic.invalid/') });
    Object.assign(document, { visibilityState: 'visible', hasFocus: () => true,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents) });
    const root = createRoot(dom.container);
    const streamStarted = deferred<void>();
    let heartbeat = () => {};
    const fixtureFetch = globalThis.fetch;
    // Keep the real SDK/event pipeline, with a healthy stream and unchanged session detail.
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/global/event')) {
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
    const firstStarted = deferred<Request>();
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let reads = 0, commits = 0;
    const page = (id: string) => Response.json([{ info: { id, sessionID: session.id, role: 'user', time: { created: 1 },
      agent: 'build', model: { providerID: 'p', modelID: 'm' } }, parts: [] }]);
    fixture.handlers.history = async request => {
      reads++;
      if (reads === 1) { firstStarted.resolve(request); return firstResponse.promise; }
      return secondResponse.promise;
    };
    useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: directory });
    let reading: Promise<void> | undefined;
    let stop = () => {};
    try {
      await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="">{null}</SyncProvider>));
      const loader = getImperativeSessionMessageLoader()!;
      // Count actual store publications, not loader notifications or visibility callbacks.
      const { getSyncChildStores } = await import('./sync-refs');
      const store = getSyncChildStores().ensureChild(directory, { bootstrap: false });
      stop = store.subscribe((state, previous) => { if (state.message[session.id] !== previous.message[session.id]) commits++; });
      reading = loader.ensure(target, { reason: 'navigation' });
      const first = await firstStarted.promise;
      await streamStarted.promise;
      await sleep(50); // Let the first heartbeat establish the connection before hiding.
      if (scenario !== 'healthy') {
        Object.assign(document, { visibilityState: 'hidden' });
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        expect(first.signal.reason).toMatchObject({ origin: 'hidden' });
        expect(loader.getSnapshot(target)).toMatchObject({ status: 'idle', resolved: false, error: null });
        if (scenario === 'hide-show') { firstResponse.resolve(page('old')); await reading; }
        const detail = await opencodeClient.getScopedSdkClient(directory).session.get({ sessionID: session.id });
        expect(detail.data).toEqual(session);
        heartbeat(); // No message update or reconnect that could request history.
        await sleep(50);
        expect(document.visibilityState).toBe('hidden');
        expect(reads).toBe(1);
        Object.assign(document, { visibilityState: 'visible' });
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        documentEvents.dispatchEvent(new Event('visibilitychange')); // Foreground demand is consumed once.
        await sleep(50);
        expect(reads).toBe(2);
        secondResponse.resolve(page('fresh'));
        // Observe automatic foreground hydration without requesting another load.
        for (let attempts = 0; attempts < 100 && loader.getSnapshot(target).status !== 'ready'; attempts++) await sleep(10);
        if (scenario === 'hide-show-stale') { firstResponse.resolve(page('old')); await reading; }
      } else { firstResponse.resolve(page('fresh')); await reading; }
      expect(loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true });
      expect(store.getState().message[session.id]?.map(message => message.id)).toEqual(['fresh']);
      expect(commits).toBe(1);
      expect(reads).toBe(scenario === 'healthy' ? 1 : 2);
      expect(sentReports()).toEqual([]);
    } finally {
      firstResponse.resolve(page('old')); secondResponse.resolve(page('fresh')); await reading;
      stop(); await act(async () => root.unmount()); await sleep(10);
      if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
      globalThis.fetch = fixtureFetch;
      dom.restore();
    }
  }, 10_000);
}

function holdHistory() {
  const started = deferred<Request>();
  let fail = () => {};
  fixture!.handlers.history = async request => new Promise<Response>((_resolve, reject) => {
    fail = () => reject(new DOMException('transport cancelled', 'AbortError'));
    request.signal.addEventListener('abort', fail, { once: true });
    started.resolve(request);
  });
  return { started: started.promise, fail: () => fail() };
}

// Exercise the actual SyncProvider registrations, not only a hand-written cancellation call.
for (const event of ['navigation', 'visibilitychange', 'pagehide', 'beforeunload'] as const) {
  test(`${event} cancels a current refresh with an owned reason and no report (#1058)`, async () => {
    fixture = nativeDraftFixture();
    const dom = installHookTestDom();
    const windowEvents = new EventTarget(), documentEvents = new EventTarget();
    const add = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
    const remove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://synthetic.invalid/') });
    Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: windowEvents.addEventListener.bind(windowEvents) });
    Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: windowEvents.removeEventListener.bind(windowEvents) });
    Object.assign(document, { visibilityState: 'visible', hasFocus: () => true,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents) });
    const root = createRoot(dom.container);
    let reading: Promise<void> | undefined, held: ReturnType<typeof holdHistory> | undefined;
    useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: directory });
    try {
      await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="">{null}</SyncProvider>));
      const loader = getImperativeSessionMessageLoader()!;
      await loader.ensure(target, { reason: 'navigation' });
      const before = loader.getSnapshot(target);
      held = holdHistory();
      reading = loader.refreshTail(target, 50);
      const request = await held.started;
      if (event === 'navigation') useSessionUIStore.setState({ currentSessionId: 'another-session', currentSessionDirectory: '/another-project' });
      else if (event === 'visibilitychange') {
        Object.assign(document, { visibilityState: 'hidden' });
        documentEvents.dispatchEvent(new Event(event));
      } else windowEvents.dispatchEvent(new Event(event));
      const owned = request.signal.aborted;
      held.fail(); // Always settle the synthetic request, including on the unfixed baseline.
      await reading;
      await sleep(50);
      expect(owned).toBe(true);
      expect(request.signal.reason).toMatchObject({ name: "AbortError", origin: event === "navigation" ? "navigation" : event === "visibilitychange" ? "hidden" : "unload" });
      expect(loader.getSnapshot(target).status).toBe('ready');
      expect(loader.getSnapshot(target).resolved).toBe(before.resolved);
      expect(sentReports()).toEqual([]);
      // Revisit / foreground can read again; cancellation is not sticky failure or authoritative empty data.
      fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
      await loader.refreshTail(target, 50);
      expect(loader.getSnapshot(target).status).toBe('ready');
    } finally {
      held?.fail(); await reading;
      await act(async () => root.unmount());
      await sleep(10); // Provider disposal is intentionally deferred for Strict Mode.
      if (add) Object.defineProperty(globalThis, 'addEventListener', add); else Reflect.deleteProperty(globalThis, 'addEventListener');
      if (remove) Object.defineProperty(globalThis, 'removeEventListener', remove); else Reflect.deleteProperty(globalThis, 'removeEventListener');
      if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
      dom.restore();
    }
  }, 10_000);
}

test('one released component does not cancel another consumer of the same read (#1058)', async () => {
  fixture = nativeDraftFixture();
  const first = fixture.loader.subscribe(target, () => {});
  const last = fixture.loader.subscribe(target, () => {});
  const held = holdHistory();
  const reading = fixture.loader.ensure(target, { reason: 'navigation' });
  const request = await held.started;
  first();
  const stillOwned = !request.signal.aborted;
  last(); held.fail(); await reading;
  expect(stillOwned).toBe(true);
  expect(request.signal.reason).toMatchObject({ origin: 'disposed' });
  expect(sentReports()).toEqual([]);
});

test('component disposal after response headers aborts the body without a report (#1058)', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure(target, { reason: 'navigation' });
  const started = deferred<Request>();
  let fail = () => {};
  fixture.handlers.history = async request => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('['));
    fail = () => controller.error(new DOMException('relay body cancelled', 'AbortError'));
    request.signal.addEventListener('abort', fail, { once: true });
    started.resolve(request);
  } }), { headers: { 'content-type': 'application/json' } });
  const reading = fixture.loader.refreshTail(target, 50);
  const request = await started.promise;
  // Release the selected component, as on navigation away after the headers arrived.
  const release = fixture.loader.subscribe(target, () => {});
  release();
  fail(); await reading; await sleep(50);
  expect(request.signal.reason).toMatchObject({ name: 'AbortError', origin: 'disposed' });
  expect(fixture.loader.getSnapshot(target).status).toBe('ready');
  expect(sentReports()).toEqual([]);
});

for (const cancellation of ['newer-replacement', 'watch-release'] as const) {
  test(`${cancellation} aborts the owned replacement read (#1058)`, async () => {
    fixture = nativeDraftFixture();
    fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-read-only': '1' } });
    await fixture.loader.ensure(target, { reason: 'navigation' });
    const held = holdHistory();
    const release = new AbortController();
    // New replacements must cancel even when no external watch-release signal was supplied.
    const reading = fixture.loader.replaceHistory(target, undefined, cancellation === 'watch-release' ? release.signal : undefined);
    const request = await held.started;
    let newer: Promise<void> | undefined;
    if (cancellation === 'watch-release') release.abort();
    else {
      fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-read-only': '1' } });
      newer = fixture.loader.replaceHistory(target);
    }
    const owned = request.signal.aborted;
    held.fail(); await reading; await newer;
    expect(owned).toBe(true);
    expect(request.signal.reason).toMatchObject({ origin: cancellation === 'watch-release' ? 'navigation' : 'superseded' });
    expect(sentReports()).toEqual([]);
  });
}

test('a same-epoch tail refresh keeps a concurrent window read alive (#1058)', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure(target, { reason: 'navigation' });
  const held = holdHistory();
  const window = fixture.loader.loadAt(target, 0, 10);
  const request = await held.started;
  fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
  await fixture.loader.refreshTail(target, 50);
  const stillOwned = !request.signal.aborted;
  fixture.loader.dispose(); held.fail(); await window;
  expect(stillOwned).toBe(true);
  expect(request.signal.reason).toMatchObject({ origin: 'disposed' });
  expect(sentReports()).toEqual([]);
});

test('a new window does not reuse a superseded window promise (#1058)', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure(target, { reason: 'navigation' });
  const held = holdHistory();
  const old = fixture.loader.loadAt(target, 0, 10);
  const request = await held.started;
  fixture.loader.invalidateSession(target);
  let replacements = 0;
  fixture.handlers.history = async () => { replacements++; return Response.json([]); };
  const newer = fixture.loader.loadAt(target, 0, 10);
  held.fail(); await old; await newer;
  expect(request.signal.reason).toMatchObject({ origin: 'superseded' });
  expect(replacements).toBe(1);
  expect(sentReports()).toEqual([]);
});

for (const origin of ['dispose', 'superseded', 'runtime-switch', 'component-dispose'] as const) {
  test(`${origin} cancels the owned request without reporting (#1058)`, async () => {
    fixture = nativeDraftFixture();
    const loader = fixture.loader;
    const unsubscribe = loader.subscribe(target, () => {});
    const held = holdHistory();
    const reading = loader.ensure(target, { reason: 'navigation' });
    const request = await held.started;
    if (origin === 'dispose') loader.dispose();
    else if (origin === 'runtime-switch') fixture.switchRuntime('another-runtime');
    else if (origin === 'component-dispose') unsubscribe();
    else loader.invalidateSession(target);
    const owned = request.signal.aborted;
    held.fail(); await reading; await sleep(50);
    expect(owned).toBe(true);
    expect(request.signal.reason).toMatchObject({ name: "AbortError", origin: origin === "component-dispose" || origin === "dispose" ? "disposed" : origin === "runtime-switch" ? "runtime-changed" : origin });
    expect(sentReports()).toEqual([]);
    if (origin === 'superseded') {
      fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
      await loader.ensure(target, { reason: 'navigation' });
      expect(loader.getSnapshot(target).status).toBe('ready');
    }
  });
}
