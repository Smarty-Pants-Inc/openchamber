import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { mountedChat, ended, target } from './365-mounted-chat.fixture';
import { deferred, pageReply } from './365-mounted-http.fixture';

const CONTINUE = 'Continue in a new Pi';
const supported = () => Response.json({ healthy: true, capabilities: { ordinaryResume: 1 } });
const absent = () => Response.json({ healthy: true, capabilities: {} });
const pauseForIO = () => act(async () => { await sleep(25); });
async function ready(f: Awaited<ReturnType<typeof mountedChat>>) {
  (await f.page.take()).reply(pageReply(true));
  await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
}

for (const change of ['route', 'account', 'endpoint'] as const) test(`held health support is quarantined when ${change} changes before its answer`, async () => {
  const old = deferred<Response>(), fresh = deferred<Response>();
  const f = await mountedChat({ health: () => old.promise });
  try {
    await f.health.take(); await ready(f);
    expect(f.buttons()).not.toContain(CONTINUE);
    f.controls.health = () => fresh.promise;
    if (change === 'route') await f.select({ ...ended, directory: '/365 mounted/other' });
    if (change === 'account') await act(async () => useAuthSessionStore.getState().markAuthenticated());
    if (change === 'endpoint') await f.switchEndpoint('/next');
    await f.health.take();
    expect(f.buttons()).not.toContain(CONTINUE);
    await act(async () => fresh.resolve(absent()));
    await pauseForIO();
    await act(async () => old.resolve(supported()));
    await pauseForIO();
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))).toHaveLength(2);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(0);
    if (change === 'route') expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))
      .map(request => request.url.searchParams.get('directory'))).toEqual([target.directory, '/365 mounted/other']);
  } finally { await f.close(); }
});

for (const change of ['route', 'account', 'endpoint'] as const) test(`previously confirmed support is unavailable during the new ${change} probe`, async () => {
  const f = await mountedChat(), fresh = deferred<Response>();
  try {
    await ready(f); await f.settle(() => f.buttons().includes(CONTINUE));
    f.controls.health = () => fresh.promise;
    if (change === 'route') await f.select({ ...ended, directory: '/365 mounted/other' });
    if (change === 'account') await act(async () => useAuthSessionStore.getState().markAuthenticated());
    if (change === 'endpoint') await f.switchEndpoint('/next');
    expect(f.buttons()).not.toContain(CONTINUE);
    await pauseForIO(); // The next private response is deliberately still held.
    expect(f.buttons()).not.toContain(CONTINUE);
    await act(async () => fresh.resolve(supported()));
    await f.settle(() => f.buttons().includes(CONTINUE));
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))).toHaveLength(2);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(0);
  } finally { await f.close(); }
});

test('A-to-B-to-A endpoint switches cannot revive an older health result at the same key or URL', async () => {
  const a = deferred<Response>(), b = deferred<Response>(), currentA = deferred<Response>();
  const f = await mountedChat({ health: () => a.promise });
  try {
    await f.health.take(); await ready(f);
    f.controls.health = () => b.promise; await f.switchEndpoint('/b'); await f.health.take();
    f.controls.health = () => currentA.promise; await f.switchEndpoint(''); await f.health.take();
    await act(async () => { currentA.resolve(absent()); b.resolve(supported()); a.resolve(supported()); });
    await pauseForIO();
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))).toHaveLength(3);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(0);
  } finally { await f.close(); }
});
