import { afterEach, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { openPiVoiceSocket } from './piVoiceCall';

const NativeWebSocket = globalThis.WebSocket;
const install = <T,>(value: T) => Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value });
afterEach(() => { install(NativeWebSocket); configureRuntimeUrlResolver({}); });

test('opens the session voice socket on the active runtime with its project directory and no token', () => {
  const opened: string[] = [];
  class RecordingWebSocket extends EventTarget {
    readyState = 0;
    binaryType = 'blob';
    onopen = null; onmessage = null; onerror = null; onclose = null;
    constructor(url: string | URL) { super(); opened.push(String(url)); }
    send() {}
    close() {}
  }
  install(Object.assign(RecordingWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }));
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://code.example.test' });
  openPiVoiceSocket('ses 1', '/repo');
  expect(opened).toHaveLength(1);
  const url = new URL(opened[0]!);
  expect(url.protocol).toBe('wss:');
  expect(url.pathname).toBe('/api/session/ses%201/voice/socket');
  expect([...url.searchParams.entries()]).toEqual([['directory', '/repo']]);
});
