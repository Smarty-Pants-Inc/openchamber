import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime } from './runtime.js';

const SESSION = 'ses_durable_queue';
const input = { content: 'keep this', text: 'keep this', attachments: [], context: [], sendConfig: { providerID: 'p', modelID: 'm' } };
const owned = [];
// No wall-clock sleeps (they raced the dispatch chain under a loaded parallel run). `until` waits for the state it
// asserts; `turn` lets an armed zero-delay dispatch (dispatchQuietMs: 0) run first: timers fire in arming order.
const until = (assertion) => vi.waitFor(assertion, { timeout: 10_000, interval: 2 });
const turn = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => Promise.withResolvers();

function fixture(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-queue-boundary-'))) {
  const state = { busy: true, sent: 0, loseResponse: false, onPost: null, health: { healthy: true, version: '1.18.29' }, historyReads: 0 };
  const broadcasts = [];
  const runtime = createMessageQueueRuntime({
    dataDir,
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    buildOpenCodeUrl: (route) => `http://queue.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    dispatchQuietMs: 0,
    retryDelayMs: () => 1,
    fetchImpl: async (url, init) => {
      const route = new URL(url).pathname;
      if (route === '/global/health') return Response.json(state.health);
      if (route === '/session/status') return Response.json(state.busy ? { [SESSION]: { type: 'busy' } } : {});
      if (route.endsWith('/message')) { state.historyReads += 1; return Response.json([]); }
      if (init.method === 'POST') {
        state.sent += 1;
        await state.onPost?.();
        if (state.loseResponse) throw new Error('connection lost after upstream accepted');
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    },
  });
  owned.push({ runtime, dataDir });
  return { runtime, dataDir, state, broadcasts };
}

const idle = (runtime) => runtime.processPayload({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { runtime } of owned) runtime.stop();
  for (const { runtime } of owned) await runtime.flush().catch(() => {});
  for (const { dataDir } of owned.splice(0)) fs.rmSync(dataDir, { force: true, recursive: true });
});

it('does not acknowledge, publish, or dispatch an admission while its write is held', async () => {
  const { runtime, dataDir, state, broadcasts } = fixture();
  const entered = deferred();
  const held = deferred();
  const write = fs.promises.writeFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file).startsWith(dataDir)) { entered.resolve(); await held.promise; }
    return write(file, ...args);
  });
  state.busy = false;
  let acknowledged = false;
  const admission = runtime.enqueue(SESSION, '/repo', input).then(() => { acknowledged = true; });
  try {
    await entered.promise;
    await turn();
    expect({ acknowledged, broadcasts: broadcasts.length, sent: state.sent }).toEqual({ acknowledged: false, broadcasts: 0, sent: 0 });
  } finally { held.resolve(); await admission; }
});

it.each(['writeFile', 'rename'])('a failed %s refuses admission without a visible or dispatchable item', async (operation) => {
  const { runtime, dataDir, state, broadcasts } = fixture();
  const original = fs.promises[operation].bind(fs.promises);
  vi.spyOn(fs.promises, operation).mockImplementation(async (file, ...args) => {
    if (String(file).startsWith(dataDir)) throw new Error('synthetic disk failure');
    return original(file, ...args);
  });
  state.busy = false;
  await expect(runtime.enqueue(SESSION, '/repo', input)).rejects.toThrow();
  await turn();
  expect(runtime.snapshot().sessions).toEqual([]);
  expect(broadcasts).toEqual([]);
  expect(state.sent).toBe(0);
});

it('rejects per-session overflow without evicting any accepted item', async () => {
  const { runtime } = fixture();
  const ids = [];
  for (let n = 0; n < 20; n++) ids.push((await runtime.enqueue(SESSION, '/repo', input)).itemId);
  await expect(runtime.enqueue(SESSION, '/repo', input)).rejects.toMatchObject({ status: 409 });
  expect(runtime.sessionSnapshot(SESSION).items.map((item) => item.id)).toEqual(ids);
});

it('rejects global overflow without evicting a different session', async () => {
  const { runtime } = fixture();
  for (let n = 0; n < 50; n++) {
    runtime.setHold(`ses_capacity_${n}`, true);
    await runtime.enqueue(`ses_capacity_${n}`, '/repo', input);
  }
  const before = runtime.snapshot();
  await expect(runtime.enqueue('ses_overflow', '/repo', input)).rejects.toMatchObject({ status: 409 });
  expect(runtime.snapshot()).toEqual(before);
});

it('retains an accepted-then-lost response as unknown and never automatically posts again', async () => {
  const { runtime, state } = fixture();
  await runtime.enqueue(SESSION, '/repo', input);
  state.loseResponse = true;
  state.busy = false;
  idle(runtime);
  await until(() => expect(runtime.sessionSnapshot(SESSION).items[0]?.state).toBe('unknown'));
  idle(runtime);
  await turn();
  expect(state.sent).toBe(1);
  expect(runtime.sessionSnapshot(SESSION).items[0]).toMatchObject({ state: 'unknown' });
});

it('persists the attempt before POST and restores a crash cut as unknown without replay', async () => {
  const { runtime, dataDir, state } = fixture();
  await runtime.enqueue(SESSION, '/repo', input);
  const entered = deferred();
  const held = deferred();
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-queue-crash-'));
  state.onPost = async () => {
    for (const name of fs.readdirSync(dataDir)) fs.copyFileSync(path.join(dataDir, name), path.join(copyDir, name));
    entered.resolve();
    await held.promise;
  };
  state.busy = false;
  idle(runtime);
  await entered.promise;
  const recovered = fixture(copyDir);
  try {
    recovered.state.busy = false;
    await recovered.runtime.load();
    expect(recovered.runtime.sessionSnapshot(SESSION).items[0]).toMatchObject({ state: 'unknown' });
    idle(recovered.runtime);
    await turn();
    expect(recovered.state.sent).toBe(0);
  } finally { held.resolve(); await turn(); }
});

it('migrates v1 payloads as uncertain and preserves their original bytes', async () => {
  const { runtime, dataDir, state } = fixture();
  const payload = { ...input, id: 'queued-legacy', createdAt: 1, attachments: [{ id: 'a', filename: 'file.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,a' }], context: [{ kind: 'synthetic', text: 'private context' }] };
  const bytes = JSON.stringify({ version: 1, revision: 7, sessions: { [SESSION]: { directory: '/repo', items: [payload] } } });
  fs.writeFileSync(path.join(dataDir, 'message-queue.json'), bytes);
  state.busy = false;
  await runtime.load();
  idle(runtime);
  await turn();
  expect(state.sent).toBe(0);
  expect(runtime.sessionSnapshot(SESSION).items[0]).toMatchObject({ state: 'unknown' });
  expect(fs.readdirSync(dataDir).some((name) => name !== 'message-queue.json' && fs.readFileSync(path.join(dataDir, name), 'utf8') === bytes)).toBe(true);
});

it.each([
  { displayAttribution: 1 },
  { displayAttribution: 1, ordinaryCreateOnly: 1 },
  { displayAttribution: 1, messageQueue: 0 },
  { displayAttribution: 1, messageQueue: '1' },
  { messageQueue: 0 },
])('refuses unsupported capability %j before intake or history reads', async (capabilities) => {
  const { runtime, state, broadcasts } = fixture();
  state.health = { healthy: true, version: '1.0.0', capabilities };
  await expect(runtime.enqueue(SESSION, '/repo', input)).rejects.toMatchObject({ status: 501 });
  expect(runtime.snapshot().sessions).toEqual([]);
  expect(broadcasts).toEqual([]);
  expect(state.historyReads).toBe(0);
  expect(state.sent).toBe(0);
});

it('admits the explicit supported Chord contract and stock OpenCode path', async () => {
  const { runtime, state } = fixture();
  state.health = { healthy: true, version: '1.0.0', capabilities: { displayAttribution: 1, messageQueue: 1 } };
  await runtime.enqueue(SESSION, '/repo', input);
  state.busy = false;
  idle(runtime);
  await until(() => expect(state.sent).toBe(1));
});

it('retains full payload after a lost take response and refuses repeat transfer', async () => {
  const { runtime, dataDir, state } = fixture();
  const context = [{ kind: 'synthetic', text: 'private context' }];
  const attachments = [{ id: 'file', filename: 'x.txt', mimeType: 'text/plain', source: 'local', size: 1, dataUrl: 'data:text/plain,x' }];
  const { itemId } = await runtime.enqueue(SESSION, '/repo', { ...input, context, attachments });
  await runtime.take(SESSION, itemId); // Simulate a lost response by ignoring it.
  await expect(runtime.take(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
  runtime.stop();
  const next = fixture(dataDir);
  await next.runtime.load();
  const recovered = await next.runtime.recover(SESSION, itemId);
  expect(recovered.item).toMatchObject({ state: 'taken', context, attachments });
  await next.runtime.clear(SESSION);
  state.busy = false;
  idle(next.runtime);
  await turn();
  expect(next.state.sent).toBe(0);
  expect(next.runtime.sessionSnapshot(SESSION).items[0].state).toBe('taken');
});

it('serializes concurrent admission at capacity without losing the old head', async () => {
  const { runtime } = fixture();
  for (let n = 0; n < 19; n++) await runtime.enqueue(SESSION, '/repo', input);
  const before = runtime.sessionSnapshot(SESSION).items.map(item => item.id);
  const results = await Promise.allSettled([runtime.enqueue(SESSION, '/repo', input), runtime.enqueue(SESSION, '/repo', input)]);
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(runtime.sessionSnapshot(SESSION).items.slice(0, 19).map(item => item.id)).toEqual(before);
});

it('retains unknown if accepted settlement cannot be written, including on restart', async () => {
  const { runtime, dataDir, state } = fixture();
  await runtime.enqueue(SESSION, '/repo', input);
  const write = fs.promises.writeFile.bind(fs.promises);
  state.onPost = async () => {
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file).startsWith(dataDir)) throw new Error('settlement disk unavailable');
      return write(file, ...args);
    });
  };
  state.busy = false;
  idle(runtime);
  await until(() => expect(runtime.sessionSnapshot(SESSION).items[0].state).toBe('unknown'));
  expect(state.sent).toBe(1);
  vi.restoreAllMocks();
  runtime.stop();
  const next = fixture(dataDir);
  await next.runtime.load();
  expect(next.runtime.sessionSnapshot(SESSION).items[0].state).toBe('unknown');
});

it('old readers see no ready work and old-file rollback cannot overwrite newer custody', async () => {
  const { runtime, dataDir } = fixture();
  await runtime.enqueue(SESSION, '/repo', input);
  const legacy = path.join(dataDir, 'message-queue.json');
  expect(JSON.parse(fs.readFileSync(legacy, 'utf8')).sessions).toEqual({});
  runtime.stop();
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, revision: 0, sessions: {} }));
  const next = fixture(dataDir);
  await expect(next.runtime.load()).rejects.toThrow('reconciliation required');
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue-v2.json'), 'utf8')).sessions[SESSION].items).toHaveLength(1);
});

it.each(['unknown', 'taken', 'blocked'])('reorders pending work within a %s barrier without moving custody', async (state) => {
  const { runtime, dataDir } = fixture();
  const items = ['before', 'barrier', 'after-one', 'after-two'].map(id => ({ ...input, id, createdAt: 1, state: id === 'barrier' ? state : 'pending' }));
  fs.writeFileSync(path.join(dataDir, 'message-queue.json'), JSON.stringify({ version: 2, sessions: {} }));
  fs.writeFileSync(path.join(dataDir, 'message-queue-v2.json'), JSON.stringify({ version: 2, revision: 1, sessions: { [SESSION]: { directory: '/repo', items } } }));
  await runtime.load();
  await runtime.reorder(SESSION, ['before', 'after-two', 'after-one']);
  expect(runtime.sessionSnapshot(SESSION).items.map(item => item.id)).toEqual(['before', 'barrier', 'after-two', 'after-one']);
  const current = runtime.snapshot();
  await expect(runtime.reorder(SESSION, ['after-one', 'before', 'after-two'])).rejects.toMatchObject({ status: 409 });
  expect(runtime.snapshot()).toEqual(current);
  expect((await runtime.recover(SESSION, 'barrier')).item).toEqual(items[1]);
});

it('fails closed if corrupt-file quarantine fails, retaining the original bytes', async () => {
  const { runtime, dataDir } = fixture();
  const file = path.join(dataDir, 'message-queue.json');
  fs.writeFileSync(file, '{broken');
  vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('quarantine denied'));
  await expect(runtime.enqueue(SESSION, '/repo', input)).rejects.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});
