import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

Server.prototype.listen = () => { throw new Error('No listeners in offline reconnect test'); };
const ui = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'oc-ordinary-reconnect-'));
const loader = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
  cacheDir, appType: 'custom', resolve: { alias: { '@': ui } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const load = path => loader.ssrLoadModule(`${ui}/${path}`);
const window = new Window({ url: 'https://reconnect.invalid' });
for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, HTMLElement: window.HTMLElement, Element: window.Element,
  CustomEvent: window.CustomEvent, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.assign(document, { hasFocus: () => true });
window.__OPENCHAMBER_SURFACE__ = 'desktop';
const container = document.createElement('div');
document.body.appendChild(container);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const within = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Missing actual reconnect transition')), 5000);
  })]); } finally { clearTimeout(timer); }
};
const target = { directory: '/repo', sessionID: 'selected-B' };
const native = { generation: 'G1', sequence: 900, model: { providerID: 'native', modelID: 'B', name: 'B' }, thinkingLevel: 'high' };
const info = { id: target.sessionID, directory: '/repo', title: 'B', version: '1', nativeRuntime: 'ordinary',
  ordinary: native, time: { created: 1, updated: 1 } };
const frame = (type, properties = {}) => new TextEncoder().encode(`retry: 1\ndata: ${JSON.stringify({ directory: '/repo', payload: { type, properties } })}\n\n`);
const streams = [], secondStream = deferred(), firstConnected = deferred(), detailStarted = deferred(), held = deferred(), committed = deferred();
let blockDetail = false, released = false;
const page = () => Response.json([{ info: { id: 'tail', sessionID: target.sessionID, role: 'user',
  time: { created: 1 }, agent: 'build', model: { providerID: 'old', modelID: 'A' } },
  parts: [{ id: 'part', messageID: 'tail', sessionID: target.sessionID, type: 'text', text: 'retained' }] }],
{ headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
globalThis.fetch = async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const path = new URL(request.url).pathname.replace(/^\/api/, '');
  if (path === '/auth/url-token') return Response.json({ token: 'fixture', expiresAt: Date.now() + 60_000 });
  if (path === '/global/event') return new Response(new ReadableStream({ start(controller) {
    streams.push(controller); if (streams.length === 2) secondStream.resolve();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  if (path === `/session/${target.sessionID}/message`) return page();
  if (path === `/session/${target.sessionID}`) {
    if (blockDetail) { detailStarted.resolve(); return held.promise; }
    return Response.json(info);
  }
  if (path === '/session' || path === '/experimental/session') return Response.json([info]);
  if (path === '/session/status') return Response.json({ [target.sessionID]: { type: 'idle' } });
  if (path === '/path') return Response.json({ state: '', config: '', worktree: '/repo', directory: '/repo', home: '/home' });
  if (path === '/project/current') return Response.json({ id: 'project', worktree: '/repo' });
  if (path === '/global/config') return Response.json({});
  if (path === '/openchamber/chat-directory') return Response.json({ path: '/chats' });
  if (path === '/question' && released) committed.resolve();
  return Response.json([]);
};
window.fetch = globalThis.fetch;
const { switchRuntimeEndpoint } = await load('lib/runtime-switch.ts');
const { opencodeClient } = await load('lib/opencode/client.ts');
const { useConfigStore } = await load('stores/useConfigStore.ts');
const { SyncProvider, useSyncRuntime, setActiveSession } = await load('sync/sync-context.tsx');
switchRuntimeEndpoint({ apiBaseUrl: 'https://reconnect.invalid', runtimeKey: 'offline-reconnect', clientToken: 'fixture' });
opencodeClient.reconnectToRuntimeBaseUrl();
useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
const stopConnection = useConfigStore.subscribe(state => { if (state.isConnected) firstConnected.resolve(); });
let runtime;
const Selected = () => { runtime = useSyncRuntime(); return null; };
const root = createRoot(container);
test('actual reconnect detail cannot replace a newer native SDK event', async () => {
  let stopEvent;
  try {
    await act(async () => root.render(React.createElement(SyncProvider,
      { sdk: opencodeClient.getSdkClient(), directory: '/repo' }, React.createElement(Selected))));
    setActiveSession('/repo', target.sessionID);
    await act(async () => runtime.messageLoader.ensure(target));
    const store = runtime.childStores.getChild('/repo');
    store.setState({ session: [info] });
    await act(async () => { streams[0].enqueue(frame('server.connected')); await within(firstConnected.promise); });
    // Cross the existing 1500ms boot guard; do not bypass the reconnect caller.
    await act(async () => new Promise(resolve => setTimeout(resolve, 1600)));
    blockDetail = true;
    await act(async () => { streams[0].error(new TypeError('controlled disconnect')); await within(secondStream.promise); });
    await act(async () => { streams[1].enqueue(frame('server.connected')); await within(detailStarted.promise); });
    const newer = deferred();
    stopEvent = store.subscribe(state => { if (state.session[0]?.ordinary?.generation === 'G2') newer.resolve(); });
    await act(async () => {
      streams[1].enqueue(frame('session.updated', { info: { ...info,
        ordinary: { ...native, generation: 'G2', sequence: 0, thinkingLevel: 'low' } } }));
      await within(newer.promise);
      released = true; held.resolve(Response.json(info));
      await within(committed.promise);
    });
    assert.equal(store.getState().session[0].ordinary.generation, 'G2');
    assert.equal(store.getState().session[0].ordinary.thinkingLevel, 'low');
  } finally { stopEvent?.(); blockDetail = false; held.resolve(Response.json(info)); }
});
test.after(async () => {
  stopConnection(); setActiveSession('', '');
  await act(async () => root.unmount());
  await loader.close(); await window.happyDOM.close();
  await rm(cacheDir, { recursive: true, force: true });
  // Global and window fetch/listen seals remain installed through process exit.
});
