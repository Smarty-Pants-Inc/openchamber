import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
// Existing isolated runner owns this process; no product listener or live fetch.
Server.prototype.listen = () => { throw new Error('No listener in offline send test'); };
const ui = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'oc-ordinary-send-'));
const directory = '/offline/selected';
const posts = [], unexpected = [];
let healthGate;
// Remains installed through this isolated process's exit, including asynchronous cleanup.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.pathname === '/auth/url-token') return Response.json({ error: 'offline' }, { status: 401 });
  if (url.pathname === '/api/global/health') {
    if (healthGate) await healthGate();
    return Response.json({ healthy: true, version: 'fixture', capabilities: { displayAttribution: 1 } });
  }
  if (/^\/api\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
    posts.push({ session: url.pathname.split('/')[3], body: await request.json() });
    return new Response(null, { status: 204 });
  }
  unexpected.push({ path: url.pathname, method: request.method });
  return Response.json({ error: 'unmodeled offline route' }, { status: 400 });
};
const loader = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
  cacheDir, appType: 'custom',
  resolve: { alias: { '@': ui } }, server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] } });
const load = path => loader.ssrLoadModule(`${ui}/${path}`);
const { switchRuntimeEndpoint, getRuntimeKey } = await load('lib/runtime-switch.ts');
switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:40000', runtimeKey: 'offline-selected-send' });
const { opencodeClient } = await load('lib/opencode/client.ts');
const { ChildStoreManager } = await load('sync/child-store.ts');
const { setSyncRefs } = await load('sync/sync-refs.ts');
const { setActionRefs, setOptimisticRefs } = await load('sync/session-actions.ts');
const { useConfigStore } = await load('stores/useConfigStore.ts');
const { routeMessage } = await load('sync/session-ui-store.ts');
const stores = new ChildStoreManager(), child = stores.ensureChild(directory);
const sdk = opencodeClient.getSdkClient();
setSyncRefs(sdk, stores, directory);
setActionRefs(sdk, stores, () => directory);
setOptimisticRefs(() => {}, () => {});
useConfigStore.setState({ isConnected: true, currentProviderId: 'first-a', currentModelId: 'old-a' });
const ordinary = (generation = 'B1', modelID = 'live-b', thinkingLevel = 'high') => ({ generation, sequence: 1,
  model: { providerID: 'provider-b', modelID, name: modelID }, thinkingLevel });
const row = (id, info) => ({ id, directory, projectID: 'project', slug: id, title: id,
  version: '1', time: { created: 1, updated: 1 }, nativeRuntime: 'ordinary', ordinary: info });
const choose = info => child.setState({ session: [row('B', info), row('A', ordinary('A1', 'live-a'))] });
const send = extra => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: 'B', directory,
  content: 'offline prompt', providerID: 'first-a', modelID: 'old-a', agent: 'saved-agent', variant: 'saved-effort', ...extra });

test('actual route and SDK Send use selected native model ahead of globals/saved parameters', async () => {
  choose(ordinary());
  await send();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].session, 'B');
  assert.deepEqual(posts[0].body.model, { providerID: 'provider-b', modelID: 'live-b' });
  assert.equal(posts[0].body.agent, undefined);
  assert.equal(posts[0].body.variant, undefined);
  choose(ordinary('B1', 'new-live-b', 'medium'));
  await send();
  assert.deepEqual(posts[1].body.model, { providerID: 'provider-b', modelID: 'new-live-b' });
  choose({ generation: null, sequence: 0, model: null, thinkingLevel: null });
  await assert.rejects(send());
  assert.equal(posts.length, 2);
});
for (const [name, change] of [
  ['model', () => choose(ordinary('B1', 'reconfigured-b'))],
  ['effort', () => choose(ordinary('B1', 'live-b', 'low'))],
  ['session', () => child.setState({ session: [row('A', ordinary())] })],
  ['directory', () => child.setState({ session: [{ ...row('B', ordinary()), directory: '/other' }] })],
  ['runtime', () => switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:40000', runtimeKey: 'changed-runtime' })],
  ['generation', () => choose(ordinary('B2', 'new-generation'))],
]) {
  test(`${name} changes during actual SDK asynchronous preparation refuse before POST`, async () => {
    choose(ordinary());
    const initialPosts = posts.length;
    let started, release;
    const start = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    healthGate = async () => { started(); await held; };
    const attempt = send({ displayName: 'Offline tester' });
    const rejected = assert.rejects(attempt);
    await start;
    change();
    release();
    await rejected;
    healthGate = undefined;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:40000', runtimeKey: 'offline-selected-send' });
    assert.equal(posts.length, initialPosts);
    assert.deepEqual(unexpected, []);
  });
}
test('resolved directory aliases retain selected native ownership', async () => {
  choose(ordinary());
  await send({ directory: `${directory}/` });
  assert.deepEqual(posts.at(-1).body.model, { providerID: 'provider-b', modelID: 'live-b' });
  assert.equal(posts.at(-1).body.variant, undefined);
});
test('stock sessions retain their caller model, agent and effort', async () => {
  const stock = row('B', ordinary());
  delete stock.ordinary;
  delete stock.nativeRuntime;
  child.setState({ session: [stock] });
  await send();
  assert.deepEqual(posts.at(-1).body.model, { providerID: 'first-a', modelID: 'old-a' });
  assert.equal(posts.at(-1).body.agent, 'saved-agent');
  assert.equal(posts.at(-1).body.variant, 'saved-effort');
});
test.after(async () => {
  await loader.close();
  await rm(cacheDir, { recursive: true, force: true });
});
