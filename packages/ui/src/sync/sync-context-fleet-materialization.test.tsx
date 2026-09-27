import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { SyncProvider, setActiveSession, useEnsureSessionMessages, useSyncRuntime } from './sync-context';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { fetchMessagesForSession } from './session-actions';

// smarty-code G13 (live d11893ce, smarty-dev#777): a fresh page read /session/:id/message 35 times in its first minute,
// all for fleet sessions it did not show. Every streamed part of a session whose messages the page never loaded looked
// "incomplete" and fetched its tail, and each later idle read it again. Only a session the page shows, or whose
// history it holds, is materialized; opening a session loads its history itself.
const frame = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify({ directory: '/a', payload })}\n\n`);
const part = (sessionID: string, n: number) => ({ id: `evt_${sessionID}_${n}`, type: 'message.part.updated', properties: { sessionID,
  part: { id: `prt_${sessionID}_${n}`, messageID: `msg_${sessionID}_${n}`, sessionID, type: 'text', text: 'streamed' } } });

test('streamed parts of a session the page does not show read no messages; the shown session is still repaired', async () => {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  // The loader sizes its first page by the page's surface, which reads the location.
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://localhost/') });
  const root = createRoot(dom.container);
  const reads: string[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url), path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; controller.enqueue(frame({ id: 'evt', type: 'server.connected', properties: {} }));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const message = path.match(/^\/session\/([^/]+)\/message$/);
    if (message) { reads.push(message[1]!); return Response.json([]); }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config' || path === '/session/status') return Response.json({});
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: 'fleet-materialization', clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  // The page's SDK, through the same server as every other read here.
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: request => globalThis.fetch(request) });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  // A subagent's preview inside the open session (ToolPart) needs its child session's messages while it is mounted.
  let previewShown = false;
  const Preview = () => { useEnsureSessionMessages(previewShown ? 'ses_child' : '', '/a'); return null; };
  const settle = (ms: number) => act(async () => new Promise(done => setTimeout(done, ms)));
  try {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/a"><Selected /><Preview /></SyncProvider>));
    runtime.childStores.ensureChild('/a', { bootstrap: false });
    await settle(300);
    reads.length = 0;
    // Another agent's session streams its turn: the page never loaded it and does not show it.
    for (let n = 0; n < 3; n++) stream.enqueue(frame(part('ses_fleet', n)));
    await settle(1000);
    expect(reads).toEqual([]);
    // Nor are its parts kept without their messages: a later history load would take them as already fetched.
    const parts = runtime.childStores.getChild('/a')!.getState().part;
    expect(Object.keys(parts).filter(id => id.startsWith('msg_ses_fleet'))).toEqual([]);
    // Counterexample: the session the page shows gets its missing message fetched, as before.
    setActiveSession('/a', 'ses_open');
    stream.enqueue(frame(part('ses_open', 0)));
    await settle(500);
    expect(reads).toEqual(['ses_open']);
    // Counterexample: a subagent preview shown in the open session gets its child's missing message fetched too.
    previewShown = true;
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/a"><Selected /><Preview /></SyncProvider>));
    stream.enqueue(frame(part('ses_child', 0)));
    await settle(1000);
    expect(reads).toEqual(['ses_open', 'ses_child']);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
    dom.restore();
  }
}, 15_000);

// #126 item 4 on 3.37 (code-controls): three busy fleet sessions, opened from the sidebar, rendered no messages while the
// server had 5. A busy session streams its reply while the page does not show it; then it is opened: its full history
// is there, with the streamed reply, and nothing is dropped.
test('a busy session that streamed while not shown opens with its whole history', async () => {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://localhost/') });
  const root = createRoot(dom.container);
  const reads: string[] = [];
  const S = 'ses_busy';
  const info = (id: string, role: 'user' | 'assistant', created: number, completed?: number) => ({ id, sessionID: S, role,
    time: completed ? { created, completed } : { created }, ...(role === 'assistant'
      ? { parentID: 'msg_1', modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/a', root: '/a' }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } : { agent: 'build', model: { providerID: 'p', modelID: 'm' } }) });
  const text = (messageID: string, id: string, value: string) => ({ id, sessionID: S, messageID, type: 'text', text: value });
  // The server's 5: a user message and four assistant steps, the last still running.
  const server = [
    { info: info('msg_1', 'user', 1), parts: [text('msg_1', 'prt_1', 'do it')] },
    { info: info('msg_2', 'assistant', 2, 3), parts: [text('msg_2', 'prt_2', 'step 1')] },
    { info: info('msg_3', 'assistant', 4, 5), parts: [text('msg_3', 'prt_3', 'step 2')] },
    { info: info('msg_4', 'assistant', 6, 7), parts: [text('msg_4', 'prt_4', 'step 3')] },
    { info: info('msg_5', 'assistant', 8), parts: [text('msg_5', 'prt_5', 'working on step 4')] },
  ];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url), path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; controller.enqueue(frame({ id: 'evt', type: 'server.connected', properties: {} }));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const message = path.match(/^\/session\/([^/]+)\/message$/);
    if (message) { reads.push(message[1]!); const limit = Number(url.searchParams.get('limit') ?? 50);
      // A Pi session's history, as the gateway answers it: its accepted view, read-only here ("View only").
      return Response.json(server.slice(-limit), { headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}`, 'x-smarty-read-only': '1' } }); }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config' || path === '/session/status') return Response.json({});
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: 'fleet-busy-open', clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: request => globalThis.fetch(request) });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  const settle = (ms: number) => act(async () => new Promise(done => setTimeout(done, ms)));
  try {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/a"><Selected /></SyncProvider>));
    const store = runtime.childStores.ensureChild('/a', { bootstrap: false });
    store.setState(state => ({ session: [...state.session, { id: S, slug: S, projectID: 'project', directory: '/a', title: 'busy',
      version: '1', time: { created: 1, updated: 8 } }] as typeof state.session }));
    await settle(300);
    // Not shown: its running step streams in (a new part, text deltas), and a step completes.
    const event = (type: string, properties: unknown) => stream.enqueue(frame({ id: `evt_${Math.random()}`, type, properties }));
    event('session.status', { sessionID: S, status: { type: 'busy' } });
    event('message.updated', { info: info('msg_5', 'assistant', 8) });
    event('message.part.updated', { part: text('msg_5', 'prt_5', 'working') });
    event('message.part.delta', { sessionID: S, messageID: 'msg_5', partID: 'prt_5', field: 'text', delta: ' on step 4' });
    event('message.part.updated', { part: text('msg_6', 'prt_6', 'next step') }); // A step whose message is not here yet.
    await settle(500);
    // She opens it from the sidebar.
    setActiveSession('/a', S);
    await act(async () => { await fetchMessagesForSession(S, '/a'); });
    await settle(300);
    const state = store.getState();
    const ids = (state.message[S] ?? []).map(entry => entry.id);
    expect(ids).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4', 'msg_5']); // The whole history...
    for (const id of ids) expect((state.part[id] ?? []).length).toBeGreaterThan(0); // ...each with its parts.
    expect(getImperativeSessionMessageLoader()!.getSnapshot({ directory: '/a', sessionID: S }).status).toBe('ready');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
    dom.restore();
  }
}, 15_000);
