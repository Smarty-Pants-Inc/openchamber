import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// Review on #234 (P2 2): the steer notice's module cannot load (a missing chunk after a deploy, or the connection
// dropping after the 204). The server accepted the message, so the send still resolves with its ID, and nothing is resent.
mock.module('./promptDelivery', () => { throw new Error('chunk missing'); });

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

test('an accepted steer resolves with its message ID even when the notice cannot load', async () => {
  await loader.ensure(target);
  const sent = await opencodeClient.sendMessage({ directory: target.directory, id: target.sessionID, runtimeKey: 'a',
    providerID: 'ordinary-wire-fixture', modelID: 'test', text: 'hello', messageId: 'msg_steer' });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(sent).toBe('msg_steer');
  expect(posts).toHaveLength(1);
});
