import { afterEach, expect, test } from 'bun:test';
import { deferred } from '../runtime-isolation-fixture';
import { opencodeClient, createRuntimeOpencodeClient } from './client';
import { switchRuntimeEndpoint } from '../runtime-switch';
import { refreshRuntimeUrlAuthToken } from '../runtime-auth';

const originalFetch = globalThis.fetch;
const urlOf = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);
const mint = () => Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
const switchTo = async (runtimeKey: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey, clientToken: `fixture-${runtimeKey}` });
  await refreshRuntimeUrlAuthToken();
  opencodeClient.reconnectToRuntimeBaseUrl();
};
afterEach(() => { globalThis.fetch = originalFetch; });

test('same-URL runtime and transport switches replace the SDK and directory caches', async () => {
  let configCalls = 0;
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    configCalls += 1;
    return Response.json({ model: `fixture-${configCalls}` });
  };
  await switchTo('a');
  const sdkA = opencodeClient.getSdkClient();
  expect((await opencodeClient.getConfig('/repo')).model).toBe('fixture-1');
  expect((await opencodeClient.getConfig('/repo')).model).toBe('fixture-1');
  await switchTo('b');
  const sdkB = opencodeClient.getSdkClient();
  expect(sdkB).not.toBe(sdkA);
  expect((await opencodeClient.getConfig('/repo')).model).toBe('fixture-2');
  await switchTo('b');
  expect(opencodeClient.getSdkClient()).not.toBe(sdkB);
  expect((await opencodeClient.getConfig('/repo')).model).toBe('fixture-3');
  expect(configCalls).toBe(3);
});

test('an old same-URL SDK cannot dispatch after A-B-A', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    calls.push(urlOf(input));
    return Response.json({ id: 'same' });
  };
  await switchTo('a');
  const sdkA = createRuntimeOpencodeClient({ baseUrl: 'https://shared.example/api', directory: '/repo' });
  await switchTo('b');
  await switchTo('a');
  const result = await sdkA.session.create({ directory: '/repo' });
  expect(result.error).toBeInstanceOf(Error);
  expect(calls).toEqual([]);
});

test('old provider completion cannot remove the new runtime in-flight dedup entry', async () => {
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
  const old = opencodeClient.getProvidersForConfig('/repo');
  await aStarted.promise;
  await switchTo('b');
  const fresh = opencodeClient.getProvidersForConfig('/repo');
  await bStarted.promise;
  a.resolve(Response.json({ providers: [], default: { origin: 'a' } }));
  await expect(old).rejects.toThrow();
  const shared = opencodeClient.getProvidersForConfig('/repo');
  b.resolve(Response.json({ providers: [], default: { origin: 'b' } }));
  expect((await fresh).default).toEqual({ origin: 'b' });
  expect((await shared).default).toEqual({ origin: 'b' });
  expect(calls).toBe(2);
});

test('late native Create and Send receipts still settle the captured origin', async () => {
  const create = deferred<Response>();
  const send = deferred<Response>();
  const createStarted = deferred<void>();
  const sendStarted = deferred<void>();
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(urlOf(input));
    if (url.pathname.endsWith('/auth/url-token')) return mint();
    paths.push(url.pathname);
    if (url.pathname.endsWith('/prompt_async')) { sendStarted.resolve(); return send.promise; }
    createStarted.resolve();
    return create.promise;
  };
  await switchTo('a');
  const creating = opencodeClient.createNativeSession('/repo');
  const sending = opencodeClient.sendMessage({ runtimeKey: 'a', directory: '/repo', id: 'same',
    providerID: 'fixture-provider', modelID: 'fixture-model', text: 'hello', messageId: 'fixture-message' });
  await Promise.all([createStarted.promise, sendStarted.promise]);
  await switchTo('b');
  const session = { id: '01234567-1234-4234-9234-012345678901', slug: 'native', projectID: 'a', directory: '/repo',
    title: 'Pi', version: '1', time: { created: 1, updated: 1 },
    nativeCreation: { model: { providerID: 'fixture-provider', modelID: 'fixture-model' }, inputReady: false } };
  create.resolve(Response.json(session));
  send.resolve(new Response(null, { status: 204 }));
  const created = await creating;
  if (!('id' in created)) throw new Error('Expected the legacy 200 Session response');
  expect(created.id).toBe(session.id);
  expect(await sending).toBe('fixture-message');
  expect(paths).toEqual(['/api/session', '/api/session/same/prompt_async']);
});

test('send preparation cannot cross A-B-A even when identity and directory match again', async () => {
  let effects = 0;
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    effects += 1;
    return new Response(null, { status: 204 });
  };
  await switchTo('a');
  const sending = opencodeClient.sendMessage({ runtimeKey: 'a', directory: '/repo', id: 'same',
    providerID: 'fixture-provider', modelID: 'fixture-model', text: 'hello',
    files: [{ type: 'file', mime: 'text/markdown', filename: 'notes.md', url: 'data:text/markdown,hello' }] });
  // Both transitions occur before asynchronous attachment preparation resumes.
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey: 'b' });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://shared.example', runtimeKey: 'a' });
  await expect(sending).rejects.toThrow('stale');
  await refreshRuntimeUrlAuthToken();
  expect(effects).toBe(0);
});

test('a response body held across a switch cannot seed the current config cache', async () => {
  const body = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const reading = deferred<void>();
  let calls = 0;
  globalThis.fetch = async (input) => {
    if (urlOf(input).endsWith('/auth/url-token')) return mint();
    calls += 1;
    if (calls > 1) return Response.json({ model: 'b' });
    const response = new Response(new ReadableStream<Uint8Array>({ start: body.resolve }), { headers: { 'content-type': 'application/json' } });
    const text = response.text.bind(response);
    response.text = () => { reading.resolve(); return text(); };
    return response;
  };
  await switchTo('a');
  const old = opencodeClient.getConfig('/repo');
  const controller = await body.promise;
  await reading.promise;
  await switchTo('b');
  const fresh = opencodeClient.getConfig('/repo');
  controller.enqueue(new TextEncoder().encode('{"model":"a"}'));
  controller.close();
  await expect(old).rejects.toThrow();
  expect((await fresh).model).toBe('b');
  expect((await opencodeClient.getConfig('/repo')).model).toBe('b');
});
