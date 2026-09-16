import { afterEach, expect, test } from 'bun:test';
import { deferred } from './runtime-isolation-fixture';
import { observeRuntimeAuthResponse, resetRuntimeAuthSession, useAuthSessionStore } from './runtime-auth-expiry';
import { captureRuntimeRequestScope, switchRuntimeEndpoint } from './runtime-switch';
import { refreshRuntimeUrlAuthToken } from './runtime-auth';

const originalFetch = globalThis.fetch;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const switchTo = async (runtimeKey: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey, clientToken: `fixture-${runtimeKey}` });
  resetRuntimeAuthSession();
  await refreshRuntimeUrlAuthToken();
};
const urlOf = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);
const mint = () => Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
afterEach(() => { globalThis.fetch = originalFetch; resetRuntimeAuthSession(); });

for (const oldStatus of [200, 401]) {
  test(`late A probe ${oldStatus} cannot change B auth or hold B's probe slot`, async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const aStarted = deferred<void>();
    const bStarted = deferred<void>();
    let calls = 0;
    globalThis.fetch = async (input) => {
      if (urlOf(input).endsWith('/auth/url-token')) return mint();
      calls += 1;
      if (calls === 1) { aStarted.resolve(); return a.promise; }
      bStarted.resolve();
      return b.promise;
    };
    await switchTo('a');
    observeRuntimeAuthResponse('/api/config', 401);
    await aStarted.promise;
    await switchTo('b');
    observeRuntimeAuthResponse('/api/config', 401);
    await bStarted.promise;
    if (oldStatus === 200) useAuthSessionStore.getState().markExpired();
    a.resolve(new Response(null, { status: oldStatus }));
    await tick();
    expect(useAuthSessionStore.getState().state).toBe(oldStatus === 200 ? 'expired' : 'ok');
    b.resolve(new Response(null, { status: 200 }));
    await tick();
    expect(useAuthSessionStore.getState().state).toBe('ok');
    expect(calls).toBe(2);
  });
}

test('a stale response cannot start a confirmation against the new runtime', async () => {
  let probes = 0;
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    probes += 1;
    return new Response(null, { status: 401 });
  };
  await switchTo('a');
  const scope = captureRuntimeRequestScope();
  await switchTo('b');
  observeRuntimeAuthResponse('/api/config', 401, scope);
  await tick();
  expect(probes).toBe(0);
  expect(useAuthSessionStore.getState().state).toBe('ok');
});

test('explicit cookie reauthentication unblocks rejected URL-token minting', async () => {
  globalThis.fetch = async () => new Response(null, { status: 401 });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey: 'cookie-runtime' });
  resetRuntimeAuthSession();
  await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('(401)');
  useAuthSessionStore.getState().markReauthenticating();
  globalThis.fetch = async () => mint();
  useAuthSessionStore.getState().markAuthenticated();
  expect(await refreshRuntimeUrlAuthToken()).toBe('fixture-url-token');
});

test('provider 401 bursts share a bounded confirmation and cooldown', async () => {
  let probes = 0;
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    probes += 1;
    return new Response(null, { status: 200 });
  };
  await switchTo('a');
  for (let i = 0; i < 20; i += 1) observeRuntimeAuthResponse('/api/config', 401);
  await tick();
  observeRuntimeAuthResponse('/api/config', 401);
  await tick();
  expect(probes).toBe(1);
  expect(useAuthSessionStore.getState().state).toBe('ok');
  await switchTo('b');
  observeRuntimeAuthResponse('/api/config', 401);
  await tick();
  expect(probes).toBe(2);
});
