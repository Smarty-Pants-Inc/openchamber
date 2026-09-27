import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { SyncProvider, setActiveSession, useEnsureSessionMessages, useSyncRuntime } from './sync-context';

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
