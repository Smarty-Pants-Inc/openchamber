import { afterEach, expect, test } from 'bun:test';
import { nativeDraftFixture } from '@/sync/native-draft-fixture';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from './client';

// smarty-code#126 F9 (Paul's path under load): every /api/opencode/health probe was aborted by a 4 s client timeout,
// so the page said "Cannot reach the server" and sessions stayed "Loading…" while the server answered other reads.
let fixture: ReturnType<typeof nativeDraftFixture>, restore = () => {};
afterEach(() => { restore(); fixture?.dispose(); });
function server(health: () => Promise<Response>) {
  fixture = nativeDraftFixture();
  const inner = globalThis.fetch;
  restore = () => { globalThis.fetch = inner; };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/opencode/health')) {
      return await Promise.race([health(), new Promise<Response>((_, reject) => request.signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), { once: true }))]);
    }
    return inner(input, init);
  }) as typeof fetch;
}
const healthy = () => Response.json({ healthy: true });

test('a health answer that takes 6 s is still healthy (the probe waits up to 15 s)', async () => {
  server(() => new Promise(resolve => setTimeout(() => resolve(healthy()), 6_000)));
  expect(await opencodeClient.checkHealth()).toBe(true);
}, 12_000);

test('a probe that fails in transit is not an outage while other reads succeed', async () => {
  server(async () => { throw new TypeError('network error'); });
  expect(await opencodeClient.checkHealth()).toBe(false); // nothing has answered yet
  expect((await runtimeFetch('/api/config/settings')).ok).toBe(true); // a real read succeeds
  expect(await opencodeClient.checkHealth()).toBe(true);
});
