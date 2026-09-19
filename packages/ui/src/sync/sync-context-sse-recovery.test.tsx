import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { deferred } from '../lib/runtime-isolation-fixture';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { setActiveSession, SyncProvider, useSyncRuntime } from './sync-context';

const target = { directory: '/repo', sessionID: 'ordinary-recovery' };
const oldView = `ov2_${'a'.repeat(64)}`;
const newView = `ov2_${'b'.repeat(64)}`;
const session = { id: target.sessionID, directory: target.directory, title: 'fixture', version: '1',
  time: { created: 1, updated: 1 } };
const page = (view: string) => Response.json([{
  info: { id: 'tail', sessionID: target.sessionID, role: 'user', time: { created: 1 },
    agent: 'build', model: { providerID: 'fixture', modelID: 'test' } },
  parts: [{ id: 'part', messageID: 'tail', sessionID: target.sessionID, type: 'text', text: 'retained' }],
}], { headers: { 'x-smarty-ordinary-view': view } });
const frame = (type: string, properties = {}) => new TextEncoder().encode(
  `retry: 1\ndata: ${JSON.stringify({ directory: '/repo', payload: { id: 'evt', type, properties } })}\n\n`,
);
const within = async (promise: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Expected controlled loader transition')), 1_000);
  })]); } finally { clearTimeout(timer!); }
};

for (const mode of ['failed', 'inflight', 'busy-resync'] as const) test(`SyncProvider recovers the viewed ordinary token through the ${mode} gate`, async () => {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  const originalSurface = window.__OPENCHAMBER_SURFACE__;
  window.__OPENCHAMBER_SURFACE__ = 'desktop';
  const root = createRoot(dom.container);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const secondStream = deferred<void>();
  const thirdStream = deferred<void>();
  const thirdConnected = deferred<void>();
  const statusRequested = deferred<void>();
  const statusGate = deferred<Response>();
  let blockStatus = false;
  let connections = 0;
  const failed = deferred<void>();
  const recovered = deferred<void>();
  const firstConnected = deferred<void>();
  const recoveryConnected = deferred<void>();
  const tailRequested = deferred<void>();
  const staleTail = deferred<Response>();
  const accepted: string[] = [];
  const requests: Request[] = [];
  let history: () => Response | Promise<Response> = () => page(oldView);
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const SelectedChat = () => { runtime = useSyncRuntime(); return null; };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/global/event') {
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } });
      if (streams.length === 2) secondStream.resolve();
      if (streams.length === 3) thirdStream.resolve();
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === `/session/${target.sessionID}/message`) return history();
    if (path === `/session/${target.sessionID}`) return Response.json(session);
    if (path === '/session/status') {
      if (blockStatus) { statusRequested.resolve(); return statusGate.promise; }
      return Response.json({ [target.sessionID]: { type: 'idle' } });
    }
    if (path === '/session' || path === '/experimental/session') return Response.json([session]);
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/repo', directory: '/repo', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/repo' });
    if (path === '/global/config') return Response.json({});
    if (path === '/openchamber/chat-directory') return Response.json({ path: '/chats' });
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: 'sse-recovery', clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  const unsubscribeConnection = useConfigStore.subscribe((state, previous) => {
    if (!state.isConnected || previous.isConnected) return;
    connections += 1;
    (connections === 1 ? firstConnected : connections === 2 ? recoveryConnected : thirdConnected).resolve();
  });
  let unsubscribe = () => {};
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="/repo">
      <SelectedChat />
    </SyncProvider>));
    setActiveSession(target.directory, target.sessionID);
    await act(async () => runtime.messageLoader.ensure(target));
    expect(runtime.messageLoader.getAcceptedOrdinaryView(target, runtime.runtimeKey)).toBe(oldView);
    const retained = runtime.childStores.getChild('/repo')!.getState().message[target.sessionID];
    unsubscribe = runtime.messageLoader.subscribe(target, () => {
      if (runtime.messageLoader.getSnapshot(target).status === 'error') failed.resolve();
      const token = runtime.messageLoader.getAcceptedOrdinaryView(target, runtime.runtimeKey);
      if (token) accepted.push(token);
      if (token === newView) recovered.resolve();
    });
    await act(async () => {
      streams[0].enqueue(frame('server.connected'));
      await within(firstConnected.promise);
    });
    history = () => {
      tailRequested.resolve();
      return mode !== 'failed' ? staleTail.promise
        : Response.json({ message: 'controlled failed tail' }, { status: 409 });
    };
    await act(async () => {
      streams[0].enqueue(frame('session.error', { sessionID: target.sessionID,
        error: { name: 'APIError', data: { message: 'controlled branch change', isRetryable: false } } }));
      await within(mode !== 'failed' ? tailRequested.promise : failed.promise);
    });
    expect(runtime.childStores.getChild('/repo')!.getState().message[target.sessionID]).toBe(retained);
    expect(runtime.messageLoader.getAcceptedOrdinaryView(target, runtime.runtimeKey)).toBeUndefined();
    if (mode === 'busy-resync') {
      // Cross the documented 1500ms boot debounce, then hold the broad resync's status read.
      await act(async () => new Promise(resolve => setTimeout(resolve, 1_600)));
      blockStatus = true;
    }
    await act(async () => {
      streams[0].error(new TypeError('controlled stream loss'));
      await within(secondStream.promise);
    });
    expect(useConfigStore.getState().isConnected).toBe(false);
    history = () => page(newView);
    await act(async () => {
      streams[1].enqueue(frame('server.connected'));
      await within(recoveryConnected.promise);
      if (mode === 'busy-resync') {
        await within(statusRequested.promise);
        streams[1].error(new TypeError('controlled second stream loss'));
        await within(thirdStream.promise);
        streams[2].enqueue(frame('server.connected'));
        await within(thirdConnected.promise);
      }
      staleTail.resolve(page(oldView));
      await within(recovered.promise);
    });
    expect(runtime.messageLoader.getAcceptedOrdinaryView(target, runtime.runtimeKey)).toBe(newView);
    expect(requests.filter(request => request.method !== 'GET')
      .map(request => [request.method, new URL(request.url).pathname])).toEqual([['POST', '/auth/url-token']]);
    expect(accepted).toEqual([newView]);
    expect(streams).toHaveLength(mode === 'busy-resync' ? 3 : 2);
  } finally {
    blockStatus = false;
    statusGate.resolve(Response.json({ [target.sessionID]: { type: 'idle' } }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    unsubscribe();
    unsubscribeConnection();
    staleTail.resolve(page(oldView));
    setActiveSession('', '');
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    window.__OPENCHAMBER_SURFACE__ = originalSurface;
    dom.restore();
  }
});
