import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom';
import { switchRuntimeEndpoint } from '../lib/runtime-switch';
import { opencodeClient } from '../lib/opencode/client';
import { useConfigStore } from '../stores/useConfigStore';
import { SyncProvider } from './sync-context';

// smarty-dev#777 (Release 3.29): a gateway ended the event stream every 1-3 s. A stream the server ends is not a
// failure, so the page reconnected every 250 ms, and every reconnect resynced the page: 56 streams and 3,324 API
// requests in a minute. Consecutive short-lived streams now back off (1, 2, 4... s); each reconnect still resyncs.
const connected = new TextEncoder().encode(
  `retry: 1\ndata: ${JSON.stringify({ directory: '/repo', payload: { id: 'evt', type: 'server.connected', properties: {} } })}\n\n`);

test('a server that ends every stream right after it opens gets a few reconnects, not one every 250 ms', async () => {
  const originalFetch = globalThis.fetch;
  const dom = installHookTestDom();
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' });
  const root = createRoot(dom.container);
  const opens: number[] = [];
  const started = Date.now();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (path === '/global/event') {
      opens.push(Date.now() - started);
      // The server sends its first event, then ends the stream (a registry invalidation).
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(connected);
        setTimeout(() => controller.close(), 50);
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: '/repo', directory: '/repo', home: '/home' });
    if (path === '/project/current') return Response.json({ id: 'project', worktree: '/repo' });
    if (path === '/global/config' || path === '/session/status') return Response.json({});
    return Response.json([]);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://sync.invalid', runtimeKey: 'reconnect-backoff', clientToken: 'fixture' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false });
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory="/repo">{null}</SyncProvider>));
    await act(async () => new Promise(done => setTimeout(done, 4_000)));
    // Opens at about 0, 0.3, 1.4 and 3.5 s: the first close reconnects at once, then 1 and 2 s of backoff.
    expect(opens.length).toBeGreaterThanOrEqual(3);
    expect(opens.length).toBeLessThanOrEqual(5);
    expect(opens[1]! - opens[0]!).toBeLessThan(1_000); // One close still recovers promptly.
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.restore();
  }
}, 10_000);
