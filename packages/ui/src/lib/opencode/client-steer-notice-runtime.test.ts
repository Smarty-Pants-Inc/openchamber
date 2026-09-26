import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// Review on #234 (Astra pre-check): the notice module loads only after the page switched runtimes. The send resolved as
// accepted; the late notice must not appear in the other runtime.
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const announced: Array<string | undefined> = [];
// Bun accepts an async factory (it holds the import until it settles); its typings declare only a sync one.
mock.module('./promptDelivery', (async () => { await gate; return { announceSteered: (title?: string) => { announced.push(title); } }; }) as unknown as () => Record<string, unknown>);

const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader, setImperativeSessionMessageLoader } = await import('@/sync/session-message-loader');
const { refreshRuntimeUrlAuthToken } = await import('../runtime-auth');
const { switchRuntimeEndpoint } = await import('../runtime-switch');
const { opencodeClient } = await import('./client');

const originalFetch = globalThis.fetch;
const target = { directory: '/repo', sessionID: 'ordinary-a' };
const posts: Request[] = [];
let childStores: InstanceType<typeof ChildStoreManager>;
let loader: InstanceType<typeof SessionMessageLoader>;

beforeEach(async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    if (request.method === 'GET' && path.endsWith('/message')) {
      return Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
    }
    if (request.method === 'POST' && path.endsWith('/prompt_async')) {
      posts.push(request);
      return new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://ordinary.invalid', runtimeKey: 'a', clientToken: 'fixture-a' });
  await refreshRuntimeUrlAuthToken();
  opencodeClient.reconnectToRuntimeBaseUrl();
  childStores = new ChildStoreManager();
  loader = new SessionMessageLoader(childStores, { sdk: opencodeClient.getSdkClient(), runtimeKey: 'a' });
  setImperativeSessionMessageLoader(loader);
});

afterEach(() => {
  setImperativeSessionMessageLoader(null);
  loader.dispose();
  childStores.disposeAll();
  globalThis.fetch = originalFetch;
});

test('a notice that loads after a runtime switch is not shown', async () => {
  await loader.ensure(target);
  const sent = await opencodeClient.sendMessage({ directory: target.directory, id: target.sessionID, runtimeKey: 'a',
    providerID: 'ordinary-wire-fixture', modelID: 'test', text: 'hello', messageId: 'msg_steer' });
  expect(sent).toBe('msg_steer');
  switchRuntimeEndpoint({ apiBaseUrl: 'https://ordinary.invalid', runtimeKey: 'b', clientToken: 'fixture-b' });
  release();
  await import('./promptDelivery'); // The same load the client waits on, then its continuation.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(announced).toHaveLength(0); // toEqual([]) would accept [undefined]: this fixture has no session title.
  expect(posts).toHaveLength(1);
});
