import { afterEach, expect, test } from 'bun:test';
import { piVoiceTransport } from './piVoiceCall';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface Sent { url: URL; method: string; body: string }
function capture(respond: (request: Sent) => Response) {
  const requests: Sent[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: new URL(String(input), 'http://runtime.test'), method: init?.method ?? 'GET', body: String(init?.body ?? '') };
    requests.push(request);
    return respond(request);
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

test('voice routes use the session path, directory scope and parsed replies', async () => {
  const requests = capture(request => {
    if (request.method === 'POST' && request.url.pathname.endsWith('/voice')) return Response.json({ callId: 'call-1' });
    if (request.method === 'GET') return Response.json({ version: 2, messages: [{ type: 'offer.request' }], phase: 'connecting', transcript: null, ended: null });
    return Response.json({ accepted: 1 });
  });
  const transport = piVoiceTransport('ses/1', '/repo');
  expect(await transport.start()).toBe('call-1');
  expect((await transport.poll('call-1', 1, new AbortController().signal)).messages).toEqual([{ type: 'offer.request' }]);
  await transport.send('call-1', [{ type: 'open' }]);
  await transport.stop('call-1');
  const urls = requests.map(r => r.url);
  expect(requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST', 'DELETE']);
  expect(urls.map(u => u.pathname)).toEqual(['/api/session/ses%2F1/voice', '/api/session/ses%2F1/voice/call-1',
    '/api/session/ses%2F1/voice/call-1', '/api/session/ses%2F1/voice/call-1']);
  expect(urls.every(u => u.searchParams.get('directory') === '/repo')).toBe(true);
  expect(urls[1]!.searchParams.get('after')).toBe('1');
  expect(JSON.parse(requests[2]!.body)).toEqual({ messages: [{ type: 'open' }] });
});

test('a refused request surfaces the gateway message, never a raw body', async () => {
  capture(() => Response.json({ name: 'APIError', data: { message: 'This session already has a voice call', isRetryable: false } }, { status: 409 }));
  await expect(piVoiceTransport('s', '/repo').start()).rejects.toThrow('This session already has a voice call');
  capture(() => new Response('<html>proxy</html>', { status: 502 }));
  await expect(piVoiceTransport('s', '/repo').start()).rejects.toThrow('HTTP 502');
});
