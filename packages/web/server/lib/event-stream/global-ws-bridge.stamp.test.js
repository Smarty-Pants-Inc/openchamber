import { describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';

// openchamber#278 review 11: a View only event's journal stamp (properties.smartyAt) reaches the browser unchanged
// through the shared upstream hub and the WebSocket bridge, even for a frame held upstream of the hub while the browser
// socket was replaced. The ui reducer drops a stamped event older than its last replacing read
// (packages/ui/src/sync/view-only-journal-at.test.ts), so the stamp must survive every hop.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('global WS bridge: journal stamps', () => {
  it('forwards smartyAt unchanged for a frame released upstream after the browser socket was replaced', async () => {
    const blocks = [];
    const waiting = [];
    const upstream = (text) => { blocks.push(text); waiting.shift()?.(); };
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:1${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 60_000,
      fetchImpl: async () => ({ ok: true, status: 200, body: { getReader: () => ({
        read: async () => {
          while (!blocks.length) await new Promise((resolve) => waiting.push(resolve));
          return { value: new TextEncoder().encode(blocks.shift()), done: false };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }) } }),
    });
    const bridge = createGlobalMessageStreamWsBridge({ globalHub: hub, ownsGlobalHub: true, wsClients: new Set(),
      heartbeatIntervalMs: 60_000, processForwardedEventPayload: () => {}, triggerHealthCheck: () => {} });
    const socket = (frames) => ({ readyState: 1, send: (data) => { frames.push(JSON.parse(data)); }, on: () => {}, ping: () => {}, close: () => {} });
    try {
      const first = [];
      bridge.accept(socket(first));
      upstream(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      await sleep(30);
      const second = []; // A new browser socket: the connected hub makes it ready at once.
      bridge.accept(socket(second));
      await sleep(10);
      expect(second.some((frame) => frame.type === 'ready')).toBe(true);
      const late = { type: 'message.updated', properties: { sessionID: 's', info: { id: 'b', sessionID: 's' }, smartyAt: '7:x1-1:200' } };
      upstream(`id: e2\ndata: ${JSON.stringify({ directory: '/p', payload: late })}\n\n`); // Held upstream until now.
      await sleep(30);
      const forwarded = second.find((frame) => frame.type === 'event' && frame.payload?.properties?.info?.id === 'b');
      expect(forwarded?.payload).toEqual(late);
    } finally {
      bridge.close();
    }
  });
});
