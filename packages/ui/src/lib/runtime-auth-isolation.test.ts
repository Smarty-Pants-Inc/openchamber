import { afterEach, expect, spyOn, setSystemTime, test } from 'bun:test';
import { deferred } from './runtime-isolation-fixture';
import {
  acquireRuntimeUrlAuthToken,
  buildRuntimeAuthHeaders,
  clearRuntimeAuthCredentialProvider,
  refreshRuntimeUrlAuthToken,
  refreshLocalRuntimeUrlAuthToken,
  setRuntimeAuthCredentialProvider,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
} from './runtime-auth';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const mintResponse = () => Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeExtraHeaders(null);
  clearRuntimeAuthCredentialProvider();
  deactivateRelayTunnel();
  setSystemTime();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('a held credential cannot dispatch a mint after its authority changes', async () => {
  const credential = deferred<{ type: 'bearer'; token: string }>();
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return mintResponse();
  };
  setRuntimeAuthCredentialProvider(() => credential.promise);
  const mint = refreshRuntimeUrlAuthToken('https://runtime-a.example');
  setRuntimeBearerToken('fixture-b');
  credential.resolve({ type: 'bearer', token: 'fixture-a' });
  await expect(mint).rejects.toThrow('stale');
  expect(calls).toEqual([]);
});

test('a held mint cannot send old credentials to a newly adopted relay', async () => {
  const credential = deferred<{ type: 'bearer'; token: string }>();
  const calls: string[] = [];
  globalThis.fetch = async () => { calls.push('network'); return mintResponse(); };
  setRuntimeAuthCredentialProvider(() => credential.promise);
  const mint = refreshRuntimeUrlAuthToken('https://runtime-a.example');
  adoptRelayTunnel({ relayUrl: 'wss://relay.example', serverId: 'b', hostEncPubJwk: {} }, {
    fetch: async () => { calls.push('relay'); return mintResponse(); },
    close() {},
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    openWebSocket: () => { throw new Error('No socket in this HTTP fixture'); },
  });
  credential.resolve({ type: 'bearer', token: 'fixture-a' });
  await expect(mint).rejects.toThrow('stale');
  expect(calls).toEqual([]);
});

test('a stale mint cannot clear or replace the new authority token', async () => {
  const oldResponse = deferred<Response>();
  const started = deferred<void>();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) { started.resolve(); return oldResponse.promise; }
    return mintResponse();
  };
  setRuntimeBearerToken('fixture-a');
  const old = refreshRuntimeUrlAuthToken('https://a.example');
  await started.promise;
  setRuntimeBearerToken('fixture-b');
  expect(await refreshRuntimeUrlAuthToken('https://b.example')).toBe('fixture-url-token');
  oldResponse.resolve(new Response(null, { status: 401 }));
  await expect(old).rejects.toThrow('stale');
  expect(await refreshRuntimeUrlAuthToken('https://b.example')).toBe('fixture-url-token');
  expect(calls).toBe(2);
});

test('failed mint pacing applies to direct callers and grows to a bounded cap', async () => {
  let now = Date.now();
  let calls = 0;
  setSystemTime(now);
  setRuntimeBearerToken('fixture-a');
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 503 }); };
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('(503)');
    const before = calls;
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('waiting for recovery');
    now += delay - 1;
    setSystemTime(now);
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('waiting for recovery');
    expect(calls).toBe(before);
    now += 1;
    setSystemTime(now);
  }
  expect(calls).toBe(7);
});

test('the proactive scheduler never immediately loops on a failed mint', async () => {
  const nativeTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay) => {
    delays.push(delay ?? 0);
    const timer = nativeTimeout(handler, 60_000);
    timers.push(timer);
    return timer;
  });
  let release = () => {};
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    setRuntimeBearerToken('fixture-a');
    globalThis.fetch = async () => new Response(null, { status: 503 });
    release = acquireRuntimeUrlAuthToken('https://a.example');
    await expect(refreshRuntimeUrlAuthToken('https://a.example')).rejects.toThrow('(503)');
    expect(delays[0]).toBe(0);
    expect(delays.at(-1)).toBeGreaterThanOrEqual(900);
  } finally {
    release();
    timerSpy.mockRestore();
    for (const timer of timers) clearTimeout(timer);
  }
});

test('auth rejection waits for changed authority instead of polling', async () => {
  let calls = 0;
  setRuntimeBearerToken('fixture-a');
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 401 }); };
  await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('(401)');
  setSystemTime(Date.now() + 24 * 60 * 60_000);
  await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('waiting for recovery');
  expect(calls).toBe(1);
  setRuntimeBearerToken('fixture-b');
  globalThis.fetch = async () => { calls += 1; return mintResponse(); };
  expect(await refreshRuntimeUrlAuthToken()).toBe('fixture-url-token');
  expect(calls).toBe(2);
});

test('a deadline releases a stalled credential mint and blocks late dispatch', async () => {
  const credential = deferred<{ type: 'bearer'; token: string }>();
  const timeout = new AbortController();
  const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout.signal);
  let calls = 0;
  try {
    setRuntimeAuthCredentialProvider(() => credential.promise);
    globalThis.fetch = async () => { calls += 1; return mintResponse(); };
    const mint = refreshRuntimeUrlAuthToken();
    timeout.abort(new DOMException('Fixture deadline', 'TimeoutError'));
    await expect(mint).rejects.toThrow('Fixture deadline');
    credential.resolve({ type: 'bearer', token: 'fixture-a' });
    await Promise.resolve();
    expect(calls).toBe(0);
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('waiting for recovery');
  } finally { timeoutSpy.mockRestore(); }
});

test('local mint failures are paced per origin and a stalled request has a deadline', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 503 }); };
  await expect(refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001')).rejects.toThrow('(503)');
  await expect(refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001')).rejects.toThrow('waiting for recovery');
  globalThis.fetch = async () => { calls += 1; return mintResponse(); };
  expect(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002')).toBe('fixture-url-token');
  expect(calls).toBe(2);

  const response = deferred<Response>();
  const timeout = new AbortController();
  const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout.signal);
  try {
    globalThis.fetch = () => response.promise;
    const pending = refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3003');
    timeout.abort(new DOMException('Fixture deadline', 'TimeoutError'));
    await expect(pending).rejects.toThrow('Fixture deadline');
    response.resolve(mintResponse());
    await expect(refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3003')).rejects.toThrow('waiting for recovery');
  } finally { timeoutSpy.mockRestore(); }
});

test('explicit empty authority never falls back to read-only Electron injection', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.freeze({
    __OPENCHAMBER_CLIENT_TOKEN__: 'fixture-injected',
    __OPENCHAMBER_RUNTIME_HEADERS__: { 'x-fixture-host': 'injected' },
  }) });
  setRuntimeBearerToken(null);
  setRuntimeExtraHeaders(null);
  const headers = await buildRuntimeAuthHeaders();
  expect(headers.has('authorization')).toBe(false);
  expect(headers.has('x-fixture-host')).toBe(false);
});
