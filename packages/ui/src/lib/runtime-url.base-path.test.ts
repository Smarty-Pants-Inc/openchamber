import { describe, expect, test } from 'bun:test';
import { createRuntimeUrlResolver } from './runtime-url';
import { setRuntimeExtraHeaders } from './runtime-auth';

describe('mounted web URL resolution', () => {
  test('prefixes API, auth, health, SSE, and WebSocket paths exactly once', () => {
    const urls = createRuntimeUrlResolver({ basePath: '/code', currentHref: () => 'https://ui.example.test/code/' });

    expect(urls.api('/api/session')).toBe('/code/api/session');
    expect(urls.auth('/api/auth')).toBe('/code/api/auth');
    expect(urls.health()).toBe('/code/health');
    expect(urls.sse('/api/event')).toBe('/code/api/event');
    expect(urls.websocket('/api/global/event/ws')).toBe('wss://ui.example.test/code/api/global/event/ws');
    expect(urls.api('/code/api/session')).toBe('/code/api/session');
  });

  test('prefixes the local realtime proxy while keeping its remote target intact', () => {
    const originalWindow = globalThis.window;
    setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'fixture' });
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        location: { origin: 'https://ui.example.test', href: 'https://ui.example.test/code/' },
        __OPENCHAMBER_API_BASE_URL__: 'https://runtime.example.test',
        __OPENCHAMBER_LOCAL_ORIGIN__: 'https://ui.example.test',
      } });
      const urls = createRuntimeUrlResolver({ basePath: '/code', currentHref: () => 'https://ui.example.test/code/' });
      const sse = new URL(urls.sse('/api/global/event'));
      const socket = new URL(urls.websocket('/api/global/event/ws'));
      expect(sse.pathname).toBe('/code/api/openchamber/realtime-proxy/sse');
      expect(sse.searchParams.get('url')).toBe('https://runtime.example.test/api/global/event');
      expect(socket.pathname).toBe('/code/api/openchamber/realtime-proxy/ws');
      expect(socket.searchParams.get('url')).toBe('wss://runtime.example.test/api/global/event/ws');
    } finally {
      setRuntimeExtraHeaders(null);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('leaves remote runtimes and root deployments unchanged', () => {
    const remote = createRuntimeUrlResolver({ basePath: '/code', apiBaseUrl: 'https://runtime.example.test' });
    const root = createRuntimeUrlResolver({ basePath: '' });

    expect(remote.api('/api/session')).toBe('https://runtime.example.test/api/session');
    expect(root.api('/api/session')).toBe('/api/session');
  });
});
