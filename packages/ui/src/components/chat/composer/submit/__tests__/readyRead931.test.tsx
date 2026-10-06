import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { act } from 'react';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { readyDetail931, readyServer931 } from './readyRead931.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { nativeCreationForDraft } from '@/sync/native-draft-creation';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetNativeDraftPage } from '@/sync/native-draft-start';
import { resetSentStartsForPage } from '@/sync/native-draft-sent';
import { readyRead931Clock } from '@/sync/ready-read-931-clock';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let server: ReturnType<typeof readyServer931> | undefined;
let clock: ReturnType<typeof readyRead931Clock> | undefined;
afterEach(async () => {
  clock?.restore(); clock = undefined;
  server?.restore(); server = undefined;
  localStorage.clear(); sessionStorage.clear();
  await mounted?.dispose(); mounted = undefined;
  resetNativeDraftPage(); resetSentStartsForPage();
});
const flush = () => act(async () => { await sleep(10); });
async function until(check: () => boolean, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!check() && performance.now() < deadline) await flush();
  expect(check()).toBe(true);
}
async function setup() {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined,
    fixture => { server = readyServer931(fixture); });
  if (!server) throw new Error('Missing synthetic server');
  return { c, s: server };
}
function record() {
  if (!mounted) throw new Error('Missing mounted composer');
  const state = useSessionUIStore.getState();
  return nativeCreationForDraft(state.nativeDraftCreations, state.newSessionDraft, mounted.runtimeA);
}
const alert = () => mounted?.dom.container.querySelector('[role="alert"]')?.textContent ?? '';
const historyWording = 'The new session could not be loaded.';
const failRead = async () => { throw new DOMException('timed out', 'TimeoutError'); };

// RED first: actual Ready succeeds, then every SDK detail GET fails. No synthetic session may grant Send.
test('#931 exhausted Ready reads retain authoritative ready and show history wording; explicit check reads only', async () => {
  const { c, s } = await setup();
  s.detail = failRead;
  await c.replace('ready but not read'); await c.submit();
  await until(() => errors.length > 0);
  expect(s.operation?.phase).toBe('ready');
  expect(record()).toMatchObject({ status: 'pending', operation: { phase: 'ready' }, error: { code: 'history' }, busy: false });
  expect(alert()).toContain(historyWording);
  expect(alert()).not.toContain('It is not clear whether');
  expect(errors.every(message => !message.includes('It is not clear whether'))).toBe(true);
  const reports = await Promise.all(c.requests.filter(r => new URL(r.url).pathname.endsWith('/client-error')).map(r => r.clone().text()));
  expect(reports.some(body => body.includes('start.history'))).toBe(true);
  expect(reports.some(body => body.includes('start.unknown'))).toBe(false);
  expect(c.text()).toBe('ready but not read');
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(s.actions).toEqual(['trust', 'ready']); expect(s.detailReads).toHaveLength(5);
  s.detail = async () => Response.json(readyDetail931);
  s.readOperation = failRead;
  const check = Array.from(c.dom.container.querySelectorAll('button')).find(button => button.textContent === 'Check again');
  expect(check).toBeDefined();
  await act(async () => { check?.click(); });
  await until(() => s.operationReads.length >= 1 && errors.length >= 2);
  expect(record()).toMatchObject({ operation: { phase: 'ready' }, error: { code: 'history' }, busy: false });
  expect(alert()).toContain(historyWording);
  s.readOperation = async () => Response.json({ nativeCreation: s.operation });
  const retry = Array.from(c.dom.container.querySelectorAll('button')).find(button => button.textContent === 'Check again');
  expect(retry).toBeDefined();
  await act(async () => { retry?.click(); });
  await until(() => record()?.status === 'created');
  expect(s.operationReads.length).toBeGreaterThanOrEqual(1);
  expect(s.detailReads).toHaveLength(6);
  expect(s.detailReads.every(request => new URL(request.url).searchParams.get('directory') === directory)).toBe(true);
  expect(s.operationReads.every(request => new URL(request.url).searchParams.get('directory') === directory)).toBe(true);
  expect(c.prompts()).toHaveLength(0); // Check never sends the held input.
  await c.submit(); await until(() => c.prompts().length === 1);
  expect(c.creates()).toHaveLength(1); expect(s.actions).toEqual(['trust', 'ready']);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
}, 30_000);

test('#931 another explicit Send after exhausted detail reads recovers the same Ready session once', async () => {
  const { c, s } = await setup(); clock = readyRead931Clock();
  s.detail = failRead;
  await c.replace('send again after load failure'); await c.submit(); await until(() => errors.length > 0);
  expect(record()).toMatchObject({ operation: { phase: 'ready' }, error: { code: 'history' } });
  expect(c.prompts()).toHaveLength(0);
  s.detail = async () => Response.json(readyDetail931);
  await c.submit(); await until(() => c.prompts().length === 1, 2_000);
  expect(s.detailReads).toHaveLength(6); expect(s.operationReads).toHaveLength(1);
  expect(c.creates()).toHaveLength(1); expect(s.actions).toEqual(['trust', 'ready']);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});

test('#931 one transient SDK read failure opens the existing session and sends once without unknown', async () => {
  const { c, s } = await setup();
  s.detail = async () => s.detailReads.length === 1 ? failRead() : Response.json(readyDetail931);
  await c.replace('transient read'); await c.submit(); await until(() => c.prompts().length === 1);
  expect(s.detailReads).toHaveLength(2); expect(s.actions).toEqual(['trust', 'ready']);
  expect(c.creates()).toHaveLength(1); expect(errors).toEqual([]);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});

test('#931 definite detail 404 is history failure with one read, never retried or recreated', async () => {
  const { c, s } = await setup();
  s.detail = async () => Response.json({ name: 'NotFound', data: { message: 'gone' } }, { status: 404 });
  await c.replace('missing detail'); await c.submit(); await until(() => errors.length > 0);
  expect(record()).toMatchObject({ status: 'pending', operation: { phase: 'ready' }, error: { code: 'history' } });
  expect(s.detailReads).toHaveLength(1); expect(s.actions).toEqual(['trust', 'ready']);
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0); expect(c.text()).toBe('missing detail');
  expect(alert()).toContain(historyWording);
});

for (const historyFailure of ['http', 'missing-view'] as const) {
 test(`#931 detail success does not grant Send with ${historyFailure} history failure`, async () => {
  const { c, s } = await setup();
  c.handlers.history = async () => historyFailure === 'http'
    ? Response.json({ message: 'load failed' }, { status: 503 }) : Response.json([]);
  await c.replace('history still required'); await c.submit(); await until(() => errors.length > 0);
  expect(record()?.status).toBe('created'); expect(s.operation?.phase).toBe('ready');
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0); expect(c.text()).toBe('history still required');
  expect(alert()).toContain(historyWording);
  c.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
  await c.submit(); await until(() => c.prompts().length === 1);
  expect(c.creates()).toHaveLength(1); expect(s.actions).toEqual(['trust', 'ready']);
 });
}

test('#931 uncertain create still reports unknown and another Send never replays create', async () => {
  const { c, s } = await setup();
  c.handlers.create = failRead;
  await c.replace('uncertain create'); await c.submit(); await until(() => errors.length > 0);
  expect(record()).toMatchObject({ status: 'failed', submitted: true, error: { code: 'unknown' } });
  expect(alert()).toContain('It is not clear whether');
  await c.submit(); await flush();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0); expect(s.actions).toEqual([]);
  expect(c.text()).toBe('uncertain create');
});

test('#931 five 30-second detail timeouts cannot spend 165 seconds inside a 120-second read budget', async () => {
  const { c, s } = await setup();
  clock = readyRead931Clock(20);
  const measured = clock;
  s.detail = async () => {
    await new Promise<void>(done => setTimeout(done, 30_000));
    return failRead();
  };
  await c.replace('bounded detail reads'); await c.submit();
  await until(() => errors.length > 0, 10_000);
  // Accelerated synthetic seconds, with a small scheduling allowance. Not 120 seconds of wall-clock evidence.
  expect(measured.elapsed()).toBeLessThan(125_000);
  expect(record()).toMatchObject({ status: 'pending', operation: { phase: 'ready' }, error: { code: 'history' }, busy: false });
  expect(s.detailReads).toHaveLength(4);
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(s.actions).toEqual(['trust', 'ready']); expect(c.text()).toBe('bounded detail reads');
  // The last GET can finish after the local deadline; it must not turn failure into created or auto-send.
  await act(async () => { await sleep(800); });
  expect(record()?.status).toBe('pending'); expect(c.prompts()).toHaveLength(0);
}, 15_000);

test('#931 trust and Ready latency spend the same settle deadline as detail retries', async () => {
  const { c, s } = await setup(); clock = readyRead931Clock(20); const measured = clock;
  s.replyResponse = async operation => {
    await new Promise<void>(done => setTimeout(done, 35_000));
    return Response.json({ nativeCreation: operation });
  };
  s.detail = async () => { await new Promise<void>(done => setTimeout(done, 30_000)); return failRead(); };
  await c.replace('one enclosing deadline'); await c.submit(); await until(() => errors.length > 0, 10_000);
  expect(measured.elapsed()).toBeLessThan(125_000); expect(s.detailReads).toHaveLength(2);
  expect(record()).toMatchObject({ operation: { phase: 'ready' }, error: { code: 'history' }, busy: false });
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0); expect(s.actions).toEqual(['trust', 'ready']);
  await act(async () => { await sleep(800); }); // Join the late synthetic detail completion before teardown.
}, 15_000);

for (const switchKind of ['target', 'runtime'] as const) {
  test(`#931 held Ready detail completing after ${switchKind} switch cannot select, index or send`, async () => {
    const { c, s } = await setup();
    const gate = deferred<Response>(); s.detail = () => gate.promise;
    await c.replace('old target input'); await c.submit(); await until(() => s.detailReads.length === 1);
    await act(async () => {
      if (switchKind === 'target') c.target('b', '/native-project-b');
      else c.switchRuntime('ready-read-other-runtime');
    });
    gate.resolve(Response.json(readyDetail931)); await flush(); await flush();
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(c.children.getChild(directory)?.getState().session.some(row => row.id === session.id) ?? false).toBe(false);
    expect(useGlobalSessionsStore.getState().activeSessions.some(row => row.id === session.id)).toBe(false);
    const origin = [...useSessionUIStore.getState().nativeDraftCreations.values()].find(row => row.runtimeKey === c.runtimeA);
    expect(origin).toMatchObject({ status: 'pending', operation: { phase: 'ready' }, error: { code: 'stale' }, busy: false });
    expect(c.prompts()).toHaveLength(0); expect(c.creates()).toHaveLength(1);
    expect(s.actions).toEqual(['trust', 'ready']);
  });
}
