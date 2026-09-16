import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { deferred } from '@/lib/runtime-isolation-fixture';

const browser = new Window({ url: 'http://runtime.test/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
const install = <T,>(name: string, value: T) => {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
install('window', browser);
install('document', browser.document);
install('navigator', browser.navigator);
install('localStorage', browser.localStorage);
install('CustomEvent', browser.CustomEvent);
install('IS_REACT_ACT_ENVIRONMENT', true);
// Disable native socket IO before importing any runtime consumer. The mounted
// pipeline exercises its real fetch/SSE fallback against fakeFetch below.
install('WebSocket', undefined);
let cookieValid = true;
let mintCount = 0;
let heldRead: Response | null = null;
let streamOpens = 0;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const unexpected: string[] = [];
const json = (value: Parameters<typeof Response.json>[0], status = 200) => Response.json(value, { status });
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
  if (url.origin !== 'http://runtime.test') {
    unexpected.push(url.origin);
    throw new Error('External IO blocked by recovery fixture');
  }
  const path = url.pathname;
  if (path.endsWith('/session/held') && heldRead) return heldRead;
  if (path === '/auth/session') return json({}, cookieValid ? 200 : 401);
  if (path === '/auth/url-token') {
    mintCount += 1;
    return cookieValid ? json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 }) : json({}, 403);
  }
  if (path.endsWith('/global/event')) {
    streamOpens += 1;
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streams.add(controller);
        const close = () => { if (streams.delete(controller)) controller.close(); };
        if (signal?.aborted) close();
        else signal?.addEventListener('abort', close, { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path.endsWith('/path')) return json({ home: '/home', directory: '/workspace', worktree: '/workspace', state: '', config: '' });
  if (path.endsWith('/project/current')) return json({ id: 'fixture', worktree: '/workspace' });
  if (path.endsWith('/config/providers')) return json({ providers: [], default: {} });
  if (path.endsWith('/session/status')) return json({});
  if (path.endsWith('/settings')) return json({});
  if (path.endsWith('/passkey/status')) return json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
  if (path.endsWith('/fs/home')) return json({ home: '/home' });
  if (path.endsWith('/fs/list')) return json({ entries: [] });
  return json([]);
};
install('fetch', fakeFetch);
Object.defineProperty(browser, 'fetch', { configurable: true, value: fakeFetch });
const { SessionAuthGate } = await import('./SessionAuthGate');
const { I18nProvider } = await import('@/lib/i18n');
const { useAuthSessionStore, resetRuntimeAuthSession } = await import('@/lib/runtime-auth-expiry');
const { RuntimeSyncProvider, useSyncRuntime } = await import('@/sync/sync-context');
const { refreshRuntimeUrlAuthToken, clearRuntimeUrlAuthToken } = await import('@/lib/runtime-auth');
const { captureRuntimeRequestScope, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { subscribeNativeAuthExpiry, completeNativeAuthRecovery } = await import('@/apps/nativeAuthRecovery');

afterAll(async () => {
  await browser.happyDOM.abort();
  for (const [name, descriptor] of globals) {
    if (name === 'fetch' || name === 'WebSocket') continue;
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('mounted cookie recovery releases mint rejection and rebinds the retained loader without remount', async () => {
  resetRuntimeAuthSession();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initial = deferred<ReturnType<typeof useSyncRuntime>>();
  let active = initial.promise;
  let mounts = 0;
  const Consumer = () => {
    const runtime = useSyncRuntime();
    initial.resolve(runtime);
    active = Promise.resolve(runtime);
    React.useEffect(() => { mounts += 1; }, []);
    return <span>retained workspace</span>;
  };
  const child = <RuntimeSyncProvider directory=""><Consumer /></RuntimeSyncProvider>;
  try {
    await act(async () => { root.render(<I18nProvider><SessionAuthGate>{child}</SessionAuthGate></I18nProvider>); });
    await initial.promise;
    const before = await active;
    const previousStreamOpens = streamOpens;
    const body = deferred<string>();
    const reading = deferred<void>();
    heldRead = json({});
    heldRead.text = () => { reading.resolve(); return body.promise; };
    const oldRead = before.sdk.session.get({ sessionID: 'held' }, { throwOnError: true });
    const rejectedRead = oldRead.then(() => 'published', (error: Error) => error.message);
    await Promise.race([reading.promise, oldRead.then(() => { throw new Error('Read completed without consuming held body'); })]);
    cookieValid = false;
    clearRuntimeUrlAuthToken();
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow();
    await act(async () => { useAuthSessionStore.getState().markExpired(); });
    const count = mintCount;
    await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('waiting for recovery');
    expect(mintCount).toBe(count);
    cookieValid = true;
    const button = host.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); });
    expect(useAuthSessionStore.getState().state).toBe('ok');
    const after = await active;
    expect(after.sdk).not.toBe(before.sdk);
    expect(after.messageLoader).toBe(before.messageLoader);
    expect(after.childStores).toBe(before.childStores);
    expect(mounts).toBe(1);
    expect(streamOpens).toBe(previousStreamOpens + 1);
    expect(streams.size).toBe(1);
    await expect(before.sdk.session.list({}, { throwOnError: true })).rejects.toThrow('Runtime request is stale');
    await after.sdk.session.list({}, { throwOnError: true });
    await after.messageLoader.ensure({ directory: '/workspace', sessionID: 'session-fixture' });
    expect(after.messageLoader.getSnapshot({ directory: '/workspace', sessionID: 'session-fixture' }).status).toBe('ready');
    body.resolve(JSON.stringify({ id: 'held' }));
    expect(await rejectedRead).toBe('Runtime request is stale');
    heldRead = null;
    await refreshRuntimeUrlAuthToken();
    expect(mintCount).toBe(count + 1);
    expect(unexpected).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('mounted native acknowledgement waits for verified unchanged-transport recovery before rebinding', async () => {
  resetRuntimeAuthSession();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const probe = deferred<void>();
  let probes = 0;
  let active: ReturnType<typeof useSyncRuntime> | undefined;
  const Consumer = () => {
    active = useSyncRuntime();
    React.useEffect(() => subscribeNativeAuthExpiry(() => {
      probes += 1;
      // Same completion used by MobileApp's verified unchanged branch.
      const scope = captureRuntimeRequestScope();
      void probe.promise.then(() => completeNativeAuthRecovery(scope));
    }), []);
    return null;
  };
  try {
    await act(async () => { root.render(<RuntimeSyncProvider directory=""><Consumer /></RuntimeSyncProvider>); });
    const before = active;
    if (!before) throw new Error('Native sync consumer did not mount');
    await act(async () => { useAuthSessionStore.getState().markExpired(); });
    expect(probes).toBe(1);
    expect(useAuthSessionStore.getState().state).toBe('reauthenticating');
    expect(active?.sdk).toBe(before.sdk);
    await before.sdk.session.list({}, { throwOnError: true });
    await act(async () => { probe.resolve(); });
    expect(useAuthSessionStore.getState().state).toBe('ok');
    expect(active?.sdk).not.toBe(before.sdk);
    expect(active?.messageLoader).toBe(before.messageLoader);
    await expect(before.sdk.session.list({}, { throwOnError: true })).rejects.toThrow('Runtime request is stale');
    await active?.sdk.session.list({}, { throwOnError: true });
    const current = active?.sdk;
    await act(async () => { completeNativeAuthRecovery(captureRuntimeRequestScope()); });
    expect(active?.sdk).toBe(current);
    const retiredProbe = captureRuntimeRequestScope();
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'other-fixture' });
    useAuthSessionStore.getState().markReauthenticating();
    expect(completeNativeAuthRecovery(retiredProbe)).toBe(false);
    expect(useAuthSessionStore.getState().state).toBe('reauthenticating');
    expect(unexpected).toEqual([]);
  } finally {
    probe.resolve();
    await act(async () => root.unmount());
    host.remove();
  }
});
