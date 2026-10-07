import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { readyServer931, readyDetail931 } from './readyRead931.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { resetNativeDraftPage, useNativeDraftStarting } from '@/sync/native-draft-start';
import { resetSentStartsForPage } from '@/sync/native-draft-sent';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let server: ReturnType<typeof readyServer931> | undefined;
afterEach(async () => {
  server?.restore(); server = undefined;
  localStorage.clear(); sessionStorage.clear();
  await mounted?.dispose(); mounted = undefined;
  resetNativeDraftPage(); resetSentStartsForPage();
});
function Starting() { return <span data-ready-starting={String(useNativeDraftStarting())} />; }
async function setup() {
  const c = mounted = await mountedNativeComposer(false, undefined, <Starting />, undefined,
    fixture => { server = readyServer931(fixture); });
  if (!server) throw new Error('Missing synthetic Ready gateway');
  return { c, s: server };
}
const flush = () => act(async () => { await sleep(10); });
async function until(check: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!check() && performance.now() < deadline) await flush();
  expect(check()).toBe(true);
}
function origin() {
  return [...useSessionUIStore.getState().nativeDraftCreations.values()].find(r => r.runtimeKey === mounted?.runtimeA);
}
function assertNotPublished() {
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(mounted?.children.getChild(directory)?.getState().session.some(row => row.id === session.id) ?? false).toBe(false);
  expect(useGlobalSessionsStore.getState().activeSessions.some(row => row.id === session.id)).toBe(false);
}

// Real mounted composer -> control -> SDK -> synthetic HTTP. No creation/read owner is mocked.
for (const change of ['none', 'transport', 'auth', 'runtime'] as const) {
  test(`#931 Ready backoff keeps its original ${change} request scope`, async () => {
    const { c, s } = await setup();
    const scopes: ReturnType<typeof captureRuntimeRequestScope>[] = [];
    s.detail = async () => {
      scopes.push(captureRuntimeRequestScope());
      if (s.detailReads.length === 1) throw new DOMException('timed out', 'TimeoutError');
      return Response.json(readyDetail931);
    };
    await c.replace('ready scope original input'); await c.submit();
    await until(() => s.detailReads.length === 1);
    const scope = scopes[0];
    if (change !== 'none') await act(async () => {
      if (change === 'auth') setRuntimeExtraHeaders({ 'x-ready-scope-fixture': 'renewed' });
      else c.switchRuntime(change === 'transport' ? c.runtimeA : 'ready-scope-other-runtime');
    });
    await act(async () => { await sleep(1250); });
    console.log(JSON.stringify({ case: change, scopeCurrent: isRuntimeRequestScopeCurrent(scope),
      dispatchGenerations: scopes.map(r => [r.transportGeneration, r.authGeneration]),
      reads: s.detailReads.length, indexed: useGlobalSessionsStore.getState().activeSessions.some(r => r.id === session.id),
      status: origin()?.status, creates: c.creates().length, prompts: c.prompts().length }));
    expect(c.creates()).toHaveLength(1); expect(s.actions).toEqual(['trust', 'ready']);
    if (change === 'none') {
      expect(isRuntimeRequestScopeCurrent(scope)).toBe(true);
      expect(s.detailReads).toHaveLength(2); expect(c.prompts()).toHaveLength(1); expect(errors).toEqual([]);
    } else {
      expect(isRuntimeRequestScopeCurrent(scope)).toBe(false);
      assertNotPublished(); expect(s.detailReads).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
      expect(origin()).toMatchObject({ status: 'pending', operation: { phase: 'ready' }, busy: false,
        error: { code: change === 'runtime' ? 'stale' : 'history' } });
      if (change !== 'runtime') expect(c.text()).toBe('ready scope original input');
    }
  });
}

for (const recovery of ['check', 'send'] as const) {
  test(`#931 explicit ${recovery} recovers the same Ready after retired backoff without mutation replay`, async () => {
    const { c, s } = await setup();
    const scopes: ReturnType<typeof captureRuntimeRequestScope>[] = [];
    s.detail = async () => {
      scopes.push(captureRuntimeRequestScope());
      if (s.detailReads.length === 1) throw new DOMException('timed out', 'TimeoutError');
      return Response.json(readyDetail931);
    };
    await c.replace('explicit recovery input'); await c.submit(); await until(() => s.detailReads.length === 1);
    const operationId = s.operation?.operationId;
    await act(async () => { c.switchRuntime(c.runtimeA); });
    await act(async () => { await sleep(1250); });
    assertNotPublished(); expect(s.detailReads).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
    expect(origin()).toMatchObject({ operation: { phase: 'ready', operationId }, error: { code: 'history' }, busy: false });
    await until(() => c.dom.container.querySelector('[data-ready-starting="false"]') !== null);
    if (recovery === 'check') {
      const check = Array.from(c.dom.container.querySelectorAll('button')).find(b => b.textContent === 'Check again');
      expect(check).toBeDefined(); await act(async () => { check?.click(); });
      await until(() => origin()?.status === 'created');
      expect(c.prompts()).toHaveLength(0); expect(c.text()).toBe('explicit recovery input');
    }
    // A resolved history GET without the accepted-view header still grants no input.
    c.handlers.history = async () => Response.json([]);
    await c.submit(); await until(() => errors.length >= 2);
    expect(origin()?.status).toBe('created'); expect(c.prompts()).toHaveLength(0);
    expect(c.text()).toBe('explicit recovery input');
    c.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
    await c.submit(); await until(() => c.prompts().length === 1);
    expect(s.detailReads).toHaveLength(2); expect(s.operationReads).toHaveLength(1);
    expect(isRuntimeRequestScopeCurrent(scopes[0])).toBe(false);
    expect(isRuntimeRequestScopeCurrent(scopes[1])).toBe(true);
    expect([...s.detailReads, ...s.operationReads].every(r => new URL(r.url).searchParams.get('directory') === directory)).toBe(true);
    expect(s.operation?.operationId).toBe(operationId); expect(s.actions).toEqual(['trust', 'ready']);
    expect(c.creates()).toHaveLength(1); expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  });
}

test('#931 retired buffered detail cannot publish before the outer Start guard', async () => {
  const { c, s } = await setup(); const gate = deferred<Response>();
  s.detail = () => gate.promise;
  await c.replace('held Ready detail'); await c.submit(); await until(() => s.detailReads.length === 1);
  await act(async () => { c.switchRuntime(c.runtimeA); });
  gate.resolve(Response.json(readyDetail931)); await until(() => errors.length > 0);
  assertNotPublished(); expect(s.detailReads).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(origin()).toMatchObject({ operation: { phase: 'ready' }, error: { code: 'history' }, busy: false });
  expect(c.text()).toBe('held Ready detail');
});
