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
// This file runs in its own process through the existing isolated runner.
Server.prototype.listen = () => { throw new Error('No listeners in offline selected ingress test'); };
const ui = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'oc-ordinary-ingress-'));
const loader = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
  cacheDir, plugins: [{ name: 'offline-composer-leaf', load(id) { if (id.endsWith('/components/chat/ChatInput.tsx')) return `import React from 'react'; import { ModelControls } from './ModelControls'; export const ChatInput = () => React.createElement(ModelControls);`; } }], appType: 'custom', resolve: { alias: { '@': ui } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const load = path => loader.ssrLoadModule(`${ui}/${path}`);
const window = new Window({ url: 'https://ingress.invalid' });
for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, HTMLElement: window.HTMLElement, Element: window.Element,
  CustomEvent: window.CustomEvent, Event: window.Event, customElements: window.customElements,
  ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const container = document.createElement('div');
document.body.appendChild(container);
Object.assign(document, { hasFocus: () => true });
window.__OPENCHAMBER_SURFACE__ = 'desktop';
const target = { directory: '/repo', sessionID: 'selected-B' };
const info = { id: target.sessionID, directory: target.directory, title: 'B', version: '1',
  nativeRuntime: 'ordinary', time: { created: 1, updated: 1 } };
const native = { generation: 'new', sequence: 1, model: { providerID: 'native', modelID: 'B', name: 'B' }, thinkingLevel: 'high' };
const page = () => Response.json([{ info: { id: 'tail', sessionID: target.sessionID, role: 'user',
  time: { created: 1 }, agent: 'build', model: { providerID: 'old', modelID: 'A' } },
  parts: [{ id: 'part', messageID: 'tail', sessionID: target.sessionID, type: 'text', text: 'retained' }] }],
{ headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
let detailGets = 0, detail = () => Response.json({ ...info, ordinary: native });
const streams = [];
const requests = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const path = new URL(request.url).pathname.replace(/^\/api/, '');
  requests.push({ path, method: request.method, directory: new URL(request.url).searchParams.get('directory')
    ?? request.headers.get('x-opencode-directory') });
  if (path === '/auth/url-token') return Response.json({ token: 'fixture', expiresAt: Date.now() + 60_000 });
  if (path === '/global/event') return new Response(new ReadableStream({ start(controller) { streams.push(controller); } }),
    { headers: { 'content-type': 'text/event-stream' } });
  if (path === `/session/${target.sessionID}/message`) return page();
  if (path === `/session/${target.sessionID}`) { detailGets++; return detail(); }
  if (path === '/session' || path === '/experimental/session') return Response.json([info]);
  if (path === '/session/status') return Response.json({ [target.sessionID]: { type: 'idle' } });
  if (path === '/path') return Response.json({ state: '', config: '', worktree: '/repo', directory: '/repo', home: '/home' });
  if (path === '/project/current') return Response.json({ id: 'project', worktree: '/repo' });
  if (path === '/global/config') return Response.json({});
  if (path === '/openchamber/chat-directory') return Response.json({ path: '/chats' });
  return Response.json([]);
};
window.fetch = globalThis.fetch;
const { switchRuntimeEndpoint } = await load('lib/runtime-switch.ts');
const { opencodeClient } = await load('lib/opencode/client.ts');
const { useConfigStore } = await load('stores/useConfigStore.ts');
const { SyncProvider, useSyncRuntime } = await load('sync/sync-context.tsx');
const { useSync } = await load('sync/use-sync.ts');
switchRuntimeEndpoint({ apiBaseUrl: 'https://ingress.invalid', runtimeKey: 'offline-ingress', clientToken: 'fixture' });
opencodeClient.reconnectToRuntimeBaseUrl();
useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
const { I18nProvider } = await load('lib/i18n/context.tsx');
let runtime, hook, ChatContainer, showChat = false;
const Selected = () => { runtime = useSyncRuntime(); hook = useSync(); return showChat ? React.createElement(I18nProvider, null, React.createElement(ChatContainer, { autoOpenDraft: false })) : null; };
const root = createRoot(container);
test.before(async () => {
  await act(async () => root.render(React.createElement(SyncProvider,
    { sdk: opencodeClient.getSdkClient(), directory: '/repo' }, React.createElement(Selected))));
  await act(async () => runtime.messageLoader.ensure(target));
});
test('persisted native detail loses authority through hydration and marker bootstrap until fresh GET', async () => {
  const { persistSessions } = await load('sync/persist-cache.ts');
  const { ChildStoreManager } = await load('sync/child-store.ts');
  const { mergeBootstrapSessions } = await load('sync/reconnect-recovery.ts');
  const { readOrdinaryModel } = await load('lib/opencode/ordinaryModel.ts');
  const previous = { ...info, ordinary: { ...native, generation: 'persisted-old', thinkingLevel: 'low' } };
  persistSessions('/repo', [previous]);
  const restored = new ChildStoreManager();
  let release;
  const originalDetail = detail;
  try {
    const hydrated = restored.ensureChild('/repo', { bootstrap: false });
    assert.equal(hydrated.getState().sessionListSource, 'persisted');
    const sessions = mergeBootstrapSessions([info], null, hydrated.getState().session).sessions;
    assert.equal(readOrdinaryModel(sessions[0])?.model, null, 'persisted detail is continuity, not live authority');
    assert.equal(Object.hasOwn(sessions[0], 'ordinary'), false);
    assert.equal(previous.ordinary.generation, 'persisted-old', 'cache sanitation must not mutate the live source');
    runtime.childStores.getChild('/repo').setState({ session: sessions });
    let started;
    const beginning = new Promise(resolve => { started = resolve; });
    detail = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = hook.syncSession(target.sessionID);
    await beginning;
    assert.equal(readOrdinaryModel(runtime.childStores.getChild('/repo').getState().session[0])?.model, null);
    await act(async () => { release(Response.json({ ...info, ordinary: native })); await pending; });
    assert.equal(runtime.childStores.getChild('/repo').getState().session[0].ordinary.generation, 'new');
  } finally { release?.(Response.json({ ...info, ordinary: native })); detail = originalDetail; restored.disposeAll(); }
});
test('selected marker-only native row with cached history still fetches live model detail', async () => {
  const store = runtime.childStores.getChild('/repo');
  store.setState({ session: [info] });
  assert.equal(store.getState().message[target.sessionID].length, 1);
  const before = detailGets;
  await act(async () => hook.syncSession(target.sessionID));
  assert.equal(detailGets - before, 1, 'cached transcript must not suppress native detail discovery');
  assert.equal(store.getState().session[0].ordinary.model.modelID, 'B');
});
test('a marker-only session.updated event must not suppress later native detail discovery', async () => {
  const store = runtime.childStores.getChild('/repo');
  store.setState({ session: [info] });
  let timer, unsubscribe;
  const observed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Missing marker-only event')), 1500);
    unsubscribe = store.subscribe(state => { if (state.session[0]?.title === 'Marker update') resolve(); });
  });
  try {
    await act(async () => {
      streams[0].enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: '/repo',
        payload: { type: 'session.updated', properties: { info: { ...info, title: 'Marker update' } } } })}\n\n`));
      await observed;
    });
    assert.equal(Object.hasOwn(store.getState().session[0], 'ordinary'), false, 'a marker is not a completed detail response');
    const before = detailGets;
    await act(async () => hook.syncSession(target.sessionID));
    assert.equal(detailGets - before, 1);
    assert.equal(store.getState().session[0].ordinary.model.modelID, 'B');
  } finally { clearTimeout(timer); unsubscribe(); }
});
test('cached stock and explicitly unavailable detail keep the existing no-refetch behavior', async () => {
  const store = runtime.childStores.getChild('/repo');
  const stock = { ...info };
  delete stock.nativeRuntime;
  for (const row of [stock, { ...info, ordinary: { generation: null, sequence: 0, model: null, thinkingLevel: null } }]) {
    store.setState({ session: [row] });
    const before = detailGets;
    await act(async () => hook.syncSession(target.sessionID));
    assert.equal(detailGets, before);
    assert.deepEqual(store.getState().session[0], row);
  }
});
test('actual native session.updated event supersedes a held older-generation detail response', async () => {
  const store = runtime.childStores.getChild('/repo');
  store.setState({ session: [{ ...info, ordinary: native }] });
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  detail = () => { start(); return held; };
  const inflight = hook.syncSession(target.sessionID, true);
  await started;
  let timer, unsubscribe;
  const observed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Missing actual SDK event reduction')), 1500);
    unsubscribe = store.subscribe(state => {
      if (state.session[0]?.ordinary?.generation === 'newer') resolve();
    });
  });
  try {
    await act(async () => {
      streams[0].enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: '/repo',
        payload: { type: 'session.updated', properties: { info: { ...info,
          ordinary: { ...native, generation: 'newer', sequence: 0, thinkingLevel: 'low' } } } } })}\n\n`));
      await observed;
      release(Response.json({ ...info, ordinary: { ...native, generation: 'older', sequence: 900 } }));
      await inflight;
    });
    assert.equal(store.getState().session[0].ordinary.generation, 'newer');
    assert.equal(store.getState().session[0].ordinary.thinkingLevel, 'low');
  } finally { clearTimeout(timer); unsubscribe(); release(Response.json({ ...info, ordinary: native })); await inflight; }
});
test('actual ChatContainer fetches missing native detail after eager history is renderable', async () => {
  ({ ChatContainer } = await load('components/chat/ChatContainer.tsx'));
  const { useSessionUIStore } = await load('sync/session-ui-store.ts');
  const { persistSessions } = await load('sync/persist-cache.ts');
  const { ChildStoreManager } = await load('sync/child-store.ts');
  const { readOrdinaryModel } = await load('lib/opencode/ordinaryModel.ts');
  const store = runtime.childStores.getChild('/repo');
  const model = { ...native, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };
  persistSessions('/repo', [{ ...info, ordinary: model }]);
  const restored = new ChildStoreManager();
  store.setState({ session: restored.ensureChild('/repo', { bootstrap: false }).getState().session });
  restored.disposeAll();
  assert.equal(Object.hasOwn(store.getState().session[0], 'ordinary'), false);
  const eager = store.getState();
  store.setState({ message: { ...eager.message, [target.sessionID]: [...eager.message[target.sessionID],
    { id: 'answer', sessionID: target.sessionID, role: 'assistant', time: { created: 2, completed: 3 },
      modelID: 'gpt-6-astra', providerID: 'cliproxyapi', parentID: 'tail', agent: 'build', mode: 'build',
      path: { cwd: '/repo', root: '/repo' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] },
    part: { ...eager.part, answer: [{ id: 'answer-text', messageID: 'answer', sessionID: target.sessionID, type: 'text', text: 'Retained answer' }] } });
  assert.equal(store.getState().message[target.sessionID].length, 2, 'eager history completed before caller mount');
  useSessionUIStore.setState({ currentSessionId: target.sessionID, currentSessionDirectory: '/repo' });
  const originalDetail = detail;
  let release;
  detail = () => new Promise(resolve => { release = resolve; });
  const before = requests.length;
  const detailRequests = () => requests.slice(before).filter(request => request.path === `/session/${target.sessionID}`);
  const render = directory => root.render(React.createElement(SyncProvider,
    { sdk: opencodeClient.getSdkClient(), directory }, React.createElement(Selected)));
  try {
    showChat = true;
    await act(async () => render('/wrong-default'));
    assert.deepEqual(detailRequests(), [{ path: `/session/${target.sessionID}`, method: 'GET', directory: '/repo' }],
      'actual outer caller must request selected native detail despite renderable history and wrong default');
    assert.equal(readOrdinaryModel(store.getState().session[0]).model, null);
    assert.match(container.textContent, /Unavailable/);
    assert.equal(container.querySelector('.model-controls__model-label'), null);
    await act(async () => { release(Response.json({ ...info, ordinary: model })); });
    assert.equal(container.querySelector('.model-controls__model-label')?.textContent, 'GPT-6 Astra');
    assert.equal(container.querySelector('.model-controls__variant-label')?.textContent, 'Medium');
    await act(async () => store.setState({ session: [{ ...info,
      ordinary: { generation: null, sequence: 0, model: null, thinkingLevel: null } }] }));
    assert.match(container.textContent, /Unavailable/);
    assert.equal(container.querySelector('.model-controls__model-label'), null);
    assert.equal(detailRequests().length, 1, 'explicit unavailable must not be treated as missing detail or retried');
    assert.deepEqual(requests.slice(before).filter(request => request.method !== 'GET'), [], 'no send/create/model mutation');
  } finally {
    release?.(Response.json({ ...info, ordinary: model })); detail = originalDetail;
    showChat = false;
    await act(async () => render('/repo'));
  }
});
test('runtime switch discards a held native detail response', async () => {
  const store = runtime.childStores.getChild('/repo');
  store.setState({ session: [{ ...info, ordinary: native }] });
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  detail = () => { start(); return held; };
  const inflight = hook.syncSession(target.sessionID, true);
  await started;
  try {
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://ingress.invalid', runtimeKey: 'changed-ingress', clientToken: 'fixture' });
      release(Response.json({ ...info, ordinary: { ...native, generation: 'late-old-runtime' } }));
      await inflight;
    });
    assert.equal(store.getState().session[0].ordinary.generation, 'new');
  } finally { release(Response.json({ ...info, ordinary: native })); await inflight; }
});
test.after(async () => {
  await act(async () => root.unmount());
  // Keep fetch interception installed through process exit and cleanup.
  await loader.close();
  await window.happyDOM.close();
  await rm(cacheDir, { recursive: true, force: true });
});
