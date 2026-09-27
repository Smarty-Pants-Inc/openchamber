import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { resetClientErrorReportsForPage } from '../lib/clientErrorReport';
import { SyncProvider, useSyncRuntime } from './sync-context';

// smarty-code#536 (code-lead): org's live mid-turn session showed "The running turn stopped before the next message was
// sent" and "Interrupted" tools after a wrong idle. The page marks that locally; it now reports it at once.
const frame = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify({ directory: '/a', payload })}\n\n`);

test('a turn the page settles locally on an idle is reported with its session and what it saw', async () => {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  const root = createRoot(dom.container);
  const reports: Array<Record<string, unknown>> = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/client-error') { reports.push(await request.json() as Record<string, unknown>); return new Response(null, { status: 204 }); }
    if (path === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; controller.enqueue(frame({ id: 'evt', type: 'server.connected', properties: {} }));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/a', directory: '/a', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/a' });
    if (path === '/global/config' || path === '/session/status') return Response.json({});
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: 'settle-report', clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: request => globalThis.fetch(request) });
  let runtime!: ReturnType<typeof useSyncRuntime>;
  const Selected = () => { runtime = useSyncRuntime(); return null; };
  const settle = (ms: number) => act(async () => new Promise(done => setTimeout(done, ms)));
  try {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/a"><Selected /></SyncProvider>));
    const store = runtime.childStores.ensureChild('/a', { bootstrap: false });
    const S = 'ses_live';
    // A live turn: a prompt, and a reply still running a tool.
    store.setState(state => ({
      session_status: { ...state.session_status, [S]: { type: 'busy' } },
      message: { ...state.message, [S]: [
        { id: 'msg_1', sessionID: S, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } },
        { id: 'msg_2', sessionID: S, role: 'assistant', parentID: 'msg_1', time: { created: 2 }, modelID: 'm', providerID: 'p',
          mode: 'build', agent: 'build', path: { cwd: '/a', root: '/a' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ] as never },
      part: { ...state.part, msg_2: [{ id: 'prt_1', sessionID: S, messageID: 'msg_2', type: 'tool', tool: 'bash', callID: 'c',
        state: { status: 'running', input: {}, time: { start: 1 } } }] as never },
    }));
    await settle(300);
    resetClientErrorReportsForPage(); reports.length = 0;
    stream.enqueue(frame({ id: 'evt_idle', type: 'session.idle', properties: { sessionID: S } })); // The wrong idle.
    await settle(500);
    expect((store.getState().part.msg_2?.[0] as { state: { error?: string } }).state.error).toBe('Interrupted'); // As Paul saw.
    const settled = reports.filter(report => report.kind === 'turn-settled-locally');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ sessionID: S });
    expect(String(settled[0]!.message)).toContain('idle event');
    expect(String(settled[0]!.message)).toContain('tools interrupted: 1');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.restore();
  }
}, 15_000);
