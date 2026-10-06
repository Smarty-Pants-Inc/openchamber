import '@/sync/native-test-network';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { deferred, directory } from './native-draft-fixture';
import { failure, fx, h, interactive, record, resetInteractive, replies } from './native-draft-interactive';
import { stopBlockingStart, abandonedNativeCreations } from './native-draft-control';
import { startNativeDraft, startNativeDraftAgain } from './native-draft-start';
import { session } from './native-draft-fixture';
import { readyRead931Clock } from './ready-read-931-clock';
import { requestKey, storedRequestId } from './native-draft-intent';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setTimeout as sleep } from 'node:timers/promises';

const noWait = async () => {};
Object.defineProperty(globalThis, 'window', { configurable: true, value: new Window({ url: 'http://localhost' }) });
const cancelled = (operation: typeof h.operation) => ({ ...operation, generation: null, revision: 0, phase: 'cancelled' as const });

afterEach(() => {
  abandonedNativeCreations.clear();
  resetInteractive();
});

test('a successful Stop releases A before its held trust receipt, and B plus returned A are not globally blocked', async () => {
  interactive(() => h.operation);
  const trustResponse = deferred<Response>();
  const entered = deferred<void>();
  const inner = globalThis.fetch;
  // SAFETY: this fetch wrapper has the real transport signature; synthetic reply bodies are owned below.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/reply')) {
      // SAFETY: the synthetic gateway's reply payload is the action object sent by native-draft-control.
      const body = await request.clone().json() as { action: string };
      if (body.action === 'trust') { entered.resolve(); return trustResponse.promise; }
    }
    return inner(input, init);
  // SAFETY: the wrapper preserves the global fetch call signature and delegates every non-reply request unchanged.
  }) as typeof fetch;
  const first = startNativeDraft([], noWait).catch(error => error);
  try {
    await entered.promise;
    const operation = h.operation;
    await stopBlockingStart(operation);
    expect(abandonedNativeCreations.has(operation.operationId)).toBe(true);

    // Admission reaches this real capability refusal after release; it must not stop at a page-global reservation.
    // The one-operation interactive harness cannot supply a second project owner or a fresh A trust gate.
    fx().handlers.health = async () => new Response(null, { status: 503 });
    fx().target('b', '/native-project-b');
    const bOutcome = await failure(startNativeDraft([], noWait));
    fx().target('a', directory);
    const returnedAOutcome = await failure(startNativeDraft([], noWait));
    expect([bOutcome, returnedAOutcome]).not.toContain('sending');

    trustResponse.resolve(Response.json({ nativeCreation: cancelled(operation) }));
    await first.catch(() => undefined);
    expect(fx().creates()).toHaveLength(1);
    expect(fx().prompts()).toHaveLength(0);
  } finally {
    trustResponse.resolve(Response.json({ nativeCreation: cancelled(h.operation) }));
    await first;
    globalThis.fetch = inner;
  }
});

test('a definite Stop refusal does not mark or release the operation', async () => {
  interactive(() => h.operation);
  const operation = h.operation;
  h.abandon = () => Response.json({ name: 'APIError', data: { message: 'already finished', isRetryable: false } }, { status: 409 });
  await expect(stopBlockingStart(operation)).rejects.toThrow();
  expect(abandonedNativeCreations.has(operation.operationId)).toBe(false);
  expect(replies()).toHaveLength(0);
});

test('unknown held create ends its local wait, preserves recovery identity, and retains a late result without late indexing or Send', async () => {
  interactive(() => h.operation);
  const gate = deferred<Response>(), entered = deferred<void>();
  fx().handlers.create = async () => { entered.resolve(); return gate.promise; };
  const clock = readyRead931Clock();
  try {
    const first = failure(startNativeDraft([], noWait)); await entered.promise;
    const draft = useSessionUIStore.getState().newSessionDraft, key = requestKey(draft, fx().runtimeA);
    const id = storedRequestId(key);
    expect(id).toBeDefined();
    expect(await first).toBe('unknown');
    expect(clock.elapsed()).toBeLessThan(125_000);
    expect(record()?.status).toBe('failed'); expect(storedRequestId(key)).toBe(id);
    gate.resolve(Response.json({ ...session, nativeCreation: { ...session.nativeCreation, inputReady: true } }));
    await sleep(20);
    expect(record()?.status).toBe('created'); expect(storedRequestId(key)).toBe(id);
    expect(useGlobalSessionsStore.getState().activeSessions.some(row => row.id === session.id)).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(fx().creates()).toHaveLength(1); expect(fx().prompts()).toHaveLength(0); expect(replies()).toHaveLength(0);
    await startNativeDraft([], noWait);
    expect(storedRequestId(key)).toBeUndefined(); expect(fx().creates()).toHaveLength(1); expect(fx().prompts()).toHaveLength(0);
  } finally { clock.restore(); gate.resolve(Response.json(session)); await sleep(10); }
}, 5000);

test('late timed-out create cannot publish or index over a newer explicitly started request, nor release its reservation', async () => {
  interactive(() => h.operation);
  const old = deferred<Response>(), newer = deferred<Response>(), secondEntered = deferred<void>();
  let count = 0;
  fx().handlers.create = async () => { if (++count === 1) return old.promise; secondEntered.resolve(); return newer.promise; };
  const clock = readyRead931Clock();
  let second: Promise<string> | undefined;
  try {
    expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
    startNativeDraftAgain(); second = failure(startNativeDraft([], noWait)); await secondEntered.promise;
    const draft = useSessionUIStore.getState().newSessionDraft, key = requestKey(draft, fx().runtimeA);
    const id = storedRequestId(key), retained = record();
    old.resolve(Response.json({ ...session, nativeCreation: { ...session.nativeCreation, inputReady: true } }));
    await sleep(20);
    expect(record()).toBe(retained); expect(storedRequestId(key)).toBe(id);
    expect(await failure(startNativeDraft([], noWait))).toBe('sending');
    expect(useGlobalSessionsStore.getState().activeSessions.some(row => row.id === session.id)).toBe(false);
    expect(fx().creates()).toHaveLength(2); expect(fx().prompts()).toHaveLength(0);
    newer.resolve(Response.json({ nativeCreation: { ...h.operation, clientRequestId: id, phase: 'cancelled' } }, { status: 202 }));
    expect(await second).toBe('stopped'); expect(storedRequestId(key)).toBeUndefined();
  } finally {
    clock.restore(); old.resolve(Response.json(session));
    newer.resolve(Response.json({ nativeCreation: h.operation }, { status: 202 })); await second; await sleep(10);
  }
}, 5000);
