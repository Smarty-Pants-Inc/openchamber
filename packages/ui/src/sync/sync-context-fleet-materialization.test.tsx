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

/** A mounted SyncProvider on '/a' whose server answers each session's history from `history`, with an event stream. */
async function mountedSync(history: (sessionID: string) => unknown[] | Promise<unknown[]>, children?: (preview: string) => React.ReactNode) {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
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
    if (message) {
      reads.push(message[1]!);
      // Pages as the server does: the newest `limit` records before the cursor, and the next cursor while older remain.
      const all = await history(message[1]!), before = url.searchParams.get('before');
      const end = before ? Number(before) : all.length, start = Math.max(0, end - Number(url.searchParams.get('limit') ?? all.length));
      const headers: Record<string, string> = { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}`, 'x-smarty-read-only': '1' };
      if (start > 0) headers['x-next-cursor'] = String(start);
      return Response.json(all.slice(start, end), { headers });
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config' || path === '/session/status') return Response.json({});
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: `fleet-${Math.random()}`, clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: request => globalThis.fetch(request) });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  let preview = '';
  const render = () => root.render(<SyncProvider sdk={sdk} directory="/a"><Selected />{children?.(preview)}</SyncProvider>);
  await act(async () => render());
  const store = runtime.childStores.ensureChild('/a', { bootstrap: false });
  const settle = (ms: number) => act(async () => new Promise(done => setTimeout(done, ms)));
  await settle(300);
  return {
    store, reads, settle,
    event: (type: string, properties: unknown) => stream.enqueue(frame({ id: `evt_${Math.random()}`, type, properties })),
    session: (id: string, parentID?: string) => store.setState(state => ({ session: [...state.session, { id, slug: id, projectID: 'project',
      directory: '/a', title: id, version: '1', time: { created: 1, updated: 9 }, ...(parentID ? { parentID } : {}) }] as typeof state.session })),
    showPreview: async (id: string) => { preview = id; await act(async () => render()); },
    dispose: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
      dom.restore();
    },
  };
}
const reply = (sessionID: string, id: string, parentID: string, created: number, completed?: number) => ({ id, sessionID, role: 'assistant',
  parentID, modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/a', root: '/a' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: completed ? { created, completed } : { created } });
const prompt = (sessionID: string, id: string, created: number) => ({ id, sessionID, role: 'user', agent: 'build',
  model: { providerID: 'p', modelID: 'm' }, time: { created } });
const tool = (sessionID: string, messageID: string, id: string, status: string) => ({ id, sessionID, messageID, type: 'tool', tool: 'bash',
  callID: id, state: status === 'completed' ? { status, input: {}, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } }
    : { status, input: {}, time: { start: 1 } } });

// Review of #294 (cdfa1618): a subagent preview that mounts on a bucket that renders but that only the stream filled
// (an earlier part was dropped while nothing showed the child) must still read the child's history.
test('a subagent preview mounting on a streamed-only bucket reads its history and gets the earlier part back', async () => {
  const C = 'ses_child';
  const history = [{ info: prompt(C, 'msg_c0', 1), parts: [] },
    { info: reply(C, 'msg_c1', 'msg_c0', 2), parts: [tool(C, 'msg_c1', 'prt_c1', 'completed'), tool(C, 'msg_c1', 'prt_c2', 'running')] }];
  const sync = await mountedSync(() => history, preview => <Preview key={preview} id={preview} />);
  try {
    sync.session(C, 'ses_parent');
    // Nothing shows the child: its first tool part arrives before its message and is not kept.
    sync.event('message.part.updated', { part: tool(C, 'msg_c1', 'prt_c1', 'completed') });
    await sync.settle(300);
    // Later its message and another part arrive: the bucket renders, but misses the first part.
    sync.event('message.updated', { info: reply(C, 'msg_c1', 'msg_c0', 2) });
    sync.event('message.part.updated', { part: tool(C, 'msg_c1', 'prt_c2', 'running') });
    await sync.settle(300);
    expect(sync.reads).toEqual([]);
    expect((sync.store.getState().part.msg_c1 ?? []).map(part => part.id)).toEqual(['prt_c2']);
    // The parent opens and mounts the child's preview; no more events come.
    await sync.showPreview(C);
    await sync.settle(500);
    expect(sync.reads).toEqual([C]);
    expect((sync.store.getState().part.msg_c1 ?? []).map(part => part.id).sort()).toEqual(['prt_c1', 'prt_c2']);
  } finally { await sync.dispose(); }
}, 15_000);
function Preview({ id }: { id: string }) { useEnsureSessionMessages(id, '/a'); return null; }

// #126 item 4 (Astra's reproduction): a session read earlier as empty (a prefetch, the whole history) then streams a reply
// whose prompt the page does not have. Opening it must read again: the timeline hides a reply without its prompt.
test('a session read earlier as empty, then streamed a reply, is read again when opened and shows its history', async () => {
  const S = 'ses_busy';
  let history: unknown[] = [];
  const sync = await mountedSync(() => history);
  try {
    sync.session(S);
    await act(async () => { await getImperativeSessionMessageLoader()!.prefetch({ directory: '/a', sessionID: S }); });
    expect(sync.reads).toEqual([S]);
    history = [{ info: prompt(S, 'msg_1', 1), parts: [{ id: 'prt_1', sessionID: S, messageID: 'msg_1', type: 'text', text: 'go' }] },
      { info: reply(S, 'msg_2', 'msg_1', 2), parts: [{ id: 'prt_2', sessionID: S, messageID: 'msg_2', type: 'text', text: 'working' }] }];
    sync.event('session.status', { sessionID: S, status: { type: 'busy' } });
    sync.event('message.updated', { info: reply(S, 'msg_2', 'msg_1', 2) });
    sync.event('message.part.updated', { part: { id: 'prt_2', sessionID: S, messageID: 'msg_2', type: 'text', text: 'working' } });
    await sync.settle(300);
    setActiveSession('/a', S);
    await act(async () => { await fetchMessagesForSession(S, '/a'); });
    await sync.settle(300);
    expect(sync.reads).toEqual([S, S]);
    expect((sync.store.getState().message[S] ?? []).map(entry => entry.id)).toEqual(['msg_1', 'msg_2']);
  } finally { await sync.dispose(); }
}, 15_000);

// Pre-check (Astra, paginated variant): the prompt is older than the first page (60 steps since). Reading the tail again
// kept the empty page's 'whole history' and no cursor, so the session still opened with no visible turn and no way to
// load older messages. Its coverage is re-established from the start.
test('a session read earlier as empty whose reply now has 60 steps opens with its prompt reachable', async () => {
  const S = 'ses_long';
  let history: unknown[] = [];
  const sync = await mountedSync(() => history);
  try {
    sync.session(S);
    await act(async () => { await getImperativeSessionMessageLoader()!.prefetch({ directory: '/a', sessionID: S }); });
    const steps = Array.from({ length: 60 }, (_, i) => ({ info: reply(S, `msg_${String(i + 2).padStart(3, '0')}`, 'msg_001', i + 2, i + 3),
      parts: [{ id: `prt_${i + 2}`, sessionID: S, messageID: `msg_${String(i + 2).padStart(3, '0')}`, type: 'text', text: `step ${i}` }] }));
    history = [{ info: prompt(S, 'msg_001', 1), parts: [{ id: 'prt_1', sessionID: S, messageID: 'msg_001', type: 'text', text: 'go' }] }, ...steps];
    sync.event('message.updated', { info: reply(S, 'msg_061', 'msg_001', 61, 62) });
    sync.event('message.part.updated', { part: { id: 'prt_61', sessionID: S, messageID: 'msg_061', type: 'text', text: 'step 59' } });
    await sync.settle(300);
    setActiveSession('/a', S);
    await act(async () => { await fetchMessagesForSession(S, '/a'); });
    await sync.settle(300);
    const ids = (sync.store.getState().message[S] ?? []).map(entry => entry.id);
    expect(ids[0]).toBe('msg_001'); // Its prompt is there, so the turn shows.
    expect(ids).toHaveLength(61);
  } finally { await sync.dispose(); }
}, 15_000);

// Pre-check (Astra, overlap): the streamed reply starts a recovery read, and she opens the session before it answers.
// The open waits for that read, then finds the coverage still stale and reloads it from the start, once.
test('opening while a recovery read of stale coverage is under way still reaches the prompt', async () => {
  const S = 'ses_overlap';
  let history: unknown[] = [];
  let release = () => {};
  let hold: Promise<void> | undefined;
  const sync = await mountedSync(async () => { if (hold) { const gate = hold; hold = undefined; await gate; } return history; });
  try {
    sync.session(S);
    await act(async () => { await getImperativeSessionMessageLoader()!.prefetch({ directory: '/a', sessionID: S }); });
    const steps = Array.from({ length: 60 }, (_, i) => ({ info: reply(S, `msg_${String(i + 2).padStart(3, '0')}`, 'msg_001', i + 2, i + 3),
      parts: [{ id: `prt_${i + 2}`, sessionID: S, messageID: `msg_${String(i + 2).padStart(3, '0')}`, type: 'text', text: `step ${i}` }] }));
    history = [{ info: prompt(S, 'msg_001', 1), parts: [{ id: 'prt_1', sessionID: S, messageID: 'msg_001', type: 'text', text: 'go' }] }, ...steps];
    hold = new Promise<void>(resolve => { release = resolve; });
    sync.event('message.updated', { info: reply(S, 'msg_061', 'msg_001', 61, 62) }); // A reply with no parts yet: a recovery read.
    await sync.settle(300);
    expect(sync.reads).toEqual([S, S]); // The recovery read is under way (held).
    setActiveSession('/a', S);
    const opening = fetchMessagesForSession(S, '/a');
    await sync.settle(100);
    release();
    await act(async () => { await opening; });
    await sync.settle(300);
    const ids = (sync.store.getState().message[S] ?? []).map(entry => entry.id);
    expect(ids[0]).toBe('msg_001');
    expect(ids).toHaveLength(61);
  } finally { await sync.dispose(); }
}, 15_000);
