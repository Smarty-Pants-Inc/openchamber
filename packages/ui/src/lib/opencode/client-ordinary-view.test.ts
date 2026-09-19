import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { refreshRuntimeUrlAuthToken } from '../runtime-auth';
import { switchRuntimeEndpoint } from '../runtime-switch';
import { deferred } from '../runtime-isolation-fixture';
import { opencodeClient } from './client';

const originalFetch = globalThis.fetch;
const view = `ov2_${'a'.repeat(64)}`;
const olderView = `ov2_${'b'.repeat(64)}`;
const target = { directory: '/repo', sessionID: 'ordinary-a' };
const params = { directory: target.directory, id: target.sessionID, runtimeKey: 'a',
  providerID: 'ordinary-wire-fixture', modelID: 'test', text: 'hello', messageId: 'msg_client' };
const requests: Request[] = [];
let childStores: ChildStoreManager;
let loader: SessionMessageLoader;
let history: (request: Request) => Promise<Response>;
let prompt: () => Promise<Response>;

const page = (token: string, id = 'tail', cursor?: string): Response => {
  const headers = new Headers({ 'x-smarty-ordinary-view': token });
  if (cursor) headers.set('x-next-cursor', cursor);
  return Response.json([{
    info: { id, sessionID: target.sessionID, role: 'user', time: { created: id === 'tail' ? 2 : 1 } },
    parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: 'text', text: id }],
  }], { headers });
};

const switchTo = async (runtimeKey: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://ordinary.invalid', runtimeKey, clientToken: `fixture-${runtimeKey}` });
  await refreshRuntimeUrlAuthToken();
  opencodeClient.reconnectToRuntimeBaseUrl();
};
const prompts = () => requests.filter(request => request.method === 'POST');

beforeEach(async () => {
  requests.length = 0;
  history = async () => page(view);
  prompt = async () => new Response(null, { status: 204 });
  // Exercise the actual SDK, runtime transport and loader. No endpoint is contacted.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/url-token') {
      return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    }
    requests.push(request);
    if (request.method === 'GET' && path.endsWith('/message')) return history(request);
    if (request.method === 'POST' && path.endsWith('/prompt_async')) return prompt();
    throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
  };
  await switchTo('a');
  opencodeClient.setDirectory('/unrelated');
  childStores = new ChildStoreManager();
  loader = new SessionMessageLoader(childStores, { sdk: opencodeClient.getSdkClient(), runtimeKey: 'a' });
  setImperativeSessionMessageLoader(loader);
});

afterEach(() => {
  setImperativeSessionMessageLoader(null);
  loader.dispose();
  childStores.disposeAll();
  opencodeClient.setDirectory(undefined);
  globalThis.fetch = originalFetch;
});

test('forwards only the materialized tail header through the real SDK, preserving request scope and body', async () => {
  const pending = deferred<Response>();
  history = async request => new URL(request.url).searchParams.has('before')
    ? page(olderView, 'older') : pending.promise;
  const loading = loader.ensure(target);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  pending.resolve(page(view, 'tail', 'older-cursor'));
  await loading;
  expect(childStores.getChild('/repo')?.getState().message[target.sessionID]?.map(message => message.id)).toEqual(['tail']);
  await loader.loadOlder(target);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBe(view);

  expect(await opencodeClient.sendMessage({ ...params, directory: '/repo/' })).toBe('msg_client');
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['GET', '/api/session/ordinary-a/message'], ['GET', '/api/session/ordinary-a/message'],
    ['POST', '/api/session/ordinary-a/prompt_async'],
  ]);
  expect(new URL(requests[0].url).searchParams.get('directory')).toBe('/repo');
  expect(new URL(requests[1].url).searchParams.get('before')).toBe('older-cursor');
  const sent = prompts()[0];
  expect(new URL(sent.url).searchParams.get('directory')).toBe('/repo');
  expect(sent.headers.get('x-smarty-ordinary-view')).toBe(view);
  expect(sent.headers.get('authorization')).toBe('Bearer fixture-a');
  expect(await sent.json()).toEqual({ model: { providerID: params.providerID, modelID: params.modelID },
    messageID: 'msg_client', parts: [{ type: 'text', text: 'hello' }] });
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
});

test('never borrows a view from another session, directory or same-URL runtime', async () => {
  await loader.ensure(target);
  await opencodeClient.sendMessage({ ...params, id: 'ordinary-b' });
  await opencodeClient.sendMessage({ ...params, directory: '/other' });
  await switchTo('b');
  await opencodeClient.sendMessage({ ...params, runtimeKey: 'b' });
  expect(prompts()).toHaveLength(3);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([null, null, null]);
  expect(prompts().map(request => request.headers.get('authorization')))
    .toEqual(['Bearer fixture-a', 'Bearer fixture-a', 'Bearer fixture-b']);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBe(view);
});

test('a failed tail read preserves records but cannot authorize the next prompt', async () => {
  await loader.ensure(target);
  history = async () => Response.json({ message: 'stale branch' }, { status: 409,
    headers: { 'x-smarty-ordinary-view': olderView } });
  await loader.refreshTail(target, 50);
  expect(loader.getSnapshot(target).status).toBe('error');
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  expect(childStores.getChild('/repo')?.getState().message[target.sessionID]?.map(message => message.id)).toEqual(['tail']);
  prompt = async () => Response.json({ message: 'missing accepted view' }, { status: 409 });
  await expect(opencodeClient.sendMessage(params)).rejects.toThrow('(409)');
  expect(prompts()).toHaveLength(1);
  expect(prompts()[0].headers.get('x-smarty-ordinary-view')).toBeNull();
});

test('view invalidation during attachment preparation prevents POST dispatch', async () => {
  await loader.ensure(target);
  const sending = opencodeClient.sendMessage({ ...params,
    files: [{ type: 'file', mime: 'text/markdown', filename: 'notes.md', url: 'data:text/markdown,hello' }] });
  loader.invalidateOrdinaryViews();
  await expect(sending).rejects.toThrow('view changed before submission');
  expect(prompts()).toHaveLength(0);
});

test('a transport failure revokes the submitted view without inventing an HTTP status or replaying', async () => {
  await loader.ensure(target);
  prompt = async () => { throw new TypeError('fixture connection lost'); };
  await expect(opencodeClient.sendMessage(params)).rejects.toThrow('Message send transport failure: fixture connection lost');
  expect(prompts()).toHaveLength(1);
  expect(prompts()[0].headers.get('x-smarty-ordinary-view')).toBe(view);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  expect(requests).toHaveLength(2);
});
