import { afterEach, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { openPiVoiceSocket } from './piVoiceCall';

afterEach(() => { configureRuntimeUrlResolver({}); });

test('opens the session voice socket on the active runtime with its project directory', async () => {
  const seen: URL[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, bun) { seen.push(new URL(request.url)); return bun.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: { message() {} } });
  try {
    configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${server.port}` });
    const socket = openPiVoiceSocket('ses 1', '/repo');
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('refused')); });
    expect(seen[0]?.pathname).toBe('/api/session/ses%201/voice/socket');
    expect(seen[0]?.searchParams.get('directory')).toBe('/repo');
    expect([...seen[0]!.searchParams.keys()]).toEqual(['directory']); // No token in the URL.
    socket.close();
  } finally { server.stop(true); }
});
