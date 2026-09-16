import { afterEach, expect, test } from 'bun:test';
import { deferred } from './runtime-isolation-fixture';
import { runtimeFetch, installRuntimeFetchBridge } from './runtime-fetch';
import { refreshRuntimeUrlAuthToken, setRuntimeAuthCredentialProvider, clearRuntimeAuthCredentialProvider } from './runtime-auth';
import { switchRuntimeEndpoint } from './runtime-switch';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';
import type { RelayTunnelClient } from './relay/tunnel-client';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const mintResponse = () => Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
const requestUrl = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);

const switchTo = async (runtimeKey: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey, clientToken: `fixture-${runtimeKey}` });
  await refreshRuntimeUrlAuthToken();
};

afterEach(() => {
  deactivateRelayTunnel();
  clearRuntimeAuthCredentialProvider();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

for (const returnToA of [false, true]) {
  test(`held request credentials reject before dispatch across ${returnToA ? 'A-B-A' : 'A-B'} at the same URL`, async () => {
    const credential = deferred<{ type: 'bearer'; token: string }>();
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      if (requestUrl(input).endsWith('/auth/url-token')) return mintResponse();
      calls.push(requestUrl(input));
      return Response.json({});
    };
    await switchTo('a');
    setRuntimeAuthCredentialProvider(() => credential.promise);
    const read = runtimeFetch('/api/config?directory=/repo');
    await switchTo('b');
    if (returnToA) await switchTo('a');
    credential.resolve({ type: 'bearer', token: 'fixture-a' });
    await expect(read).rejects.toThrow('stale');
    expect(calls).toEqual([]);
  });
}

test('a late read cannot publish under another runtime with the same URL', async () => {
  const response = deferred<Response>();
  const dispatched = deferred<void>();
  globalThis.fetch = async (input) => {
    if (requestUrl(input).endsWith('/auth/url-token')) return mintResponse();
    dispatched.resolve();
    return response.promise;
  };
  await switchTo('a');
  const read = runtimeFetch('/api/session/same?directory=/repo');
  await dispatched.promise;
  await switchTo('b');
  response.resolve(Response.json({ id: 'same', origin: 'a' }));
  await expect(read).rejects.toThrow('stale');
});

test('a late accepted effect still returns its originating receipt', async () => {
  const response = deferred<Response>();
  const dispatched = deferred<void>();
  globalThis.fetch = async (input) => {
    if (requestUrl(input).endsWith('/auth/url-token')) return mintResponse();
    dispatched.resolve();
    return response.promise;
  };
  await switchTo('a');
  const effect = runtimeFetch('/api/session/same/prompt_async?directory=/repo', { method: 'POST', body: 'fixture' });
  await dispatched.promise;
  await switchTo('b');
  response.resolve(Response.json({ acceptedAt: 'a' }));
  expect(await (await effect).json()).toEqual({ acceptedAt: 'a' });
});

test('concurrent same-path reads do not share response-affecting headers', async () => {
  const calls: string[] = [];
  const release = deferred<void>();
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input).endsWith('/auth/url-token')) return mintResponse();
    const directory = new Headers(init?.headers).get('x-opencode-directory') ?? '';
    calls.push(directory);
    await release.promise;
    return Response.json({ directory });
  };
  await switchTo('a');
  const a = runtimeFetch('/api/config', { headers: { 'x-opencode-directory': '/a' } });
  const b = runtimeFetch('/api/config', { headers: { 'x-opencode-directory': '/b' } });
  release.resolve();
  expect(await (await a).json()).toEqual({ directory: '/a' });
  expect(await (await b).json()).toEqual({ directory: '/b' });
  expect(calls).toEqual(['/a', '/b']);
});

test('two relay runtimes with the same path never share a pending read', async () => {
  const aResponse = deferred<Response>();
  const aDispatched = deferred<void>();
  globalThis.fetch = async () => mintResponse();
  await switchTo('a');
  const tunnel = (fetch: RelayTunnelClient['fetch']): RelayTunnelClient => ({
    fetch,
    close() {},
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    openWebSocket: () => { throw new Error('No socket in this HTTP fixture'); },
  });
  const descriptor = { relayUrl: 'wss://relay.example', serverId: 'a', hostEncPubJwk: {} };
  adoptRelayTunnel(descriptor, tunnel(async () => { aDispatched.resolve(); return aResponse.promise; }));
  const a = runtimeFetch('/api/config?directory=/repo');
  await aDispatched.promise;
  await switchTo('b');
  adoptRelayTunnel({ ...descriptor, serverId: 'b' }, tunnel(async () => Response.json({ origin: 'b' })));
  const b = runtimeFetch('/api/config?directory=/repo');
  aResponse.resolve(Response.json({ origin: 'a' }));
  await expect(a).rejects.toThrow('stale');
  expect(await (await b).json()).toEqual({ origin: 'b' });
});

test('the installed fetch bridge captures authority and URL before awaiting credentials', async () => {
  const credential = deferred<{ type: 'bearer'; token: string }>();
  const calls: string[] = [];
  globalThis.fetch = async () => mintResponse();
  const events = new EventTarget();
  const browser = {
    location: { origin: 'https://app.example', href: 'https://app.example/' },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    fetch: async (input: RequestInfo | URL) => { calls.push(requestUrl(input)); return Response.json({}); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  await switchTo('a');
  installRuntimeFetchBridge();
  setRuntimeAuthCredentialProvider(() => credential.promise);
  const read = browser.fetch('/api/config');
  await switchTo('b');
  credential.resolve({ type: 'bearer', token: 'fixture-a' });
  await expect(read).rejects.toThrow('stale');
  expect(calls).toEqual([]);
});
