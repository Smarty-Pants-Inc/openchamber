import { afterEach, expect, test } from 'bun:test';
import type { NativeCreationReply, NativeCreationState } from '@/lib/opencode/nativeCreation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from './input-store';
import { nativeCreationForDraft } from './native-draft-creation';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';
import { resetNativeDraftPage, startNativeDraft, startNativeDraftAgain } from './native-draft-start';
import { resumeNativeCreation } from './native-draft-control';
import { useSessionUIStore } from './session-ui-store';

// Bun has no sessionStorage; the start keeps this tab's create request id there.
const tab = new Map<string, string>();
if (!('sessionStorage' in globalThis)) Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); },
  removeItem: (key: string) => { tab.delete(key); }, clear: () => { tab.clear(); } } });

// smarty-code#126 (3.18 walk): the gateway answers 'unavailable' while the new owner cannot be read for a moment (its Pi
// is still starting), and the operation stays unsettled. That is not an outcome: Send keeps re-reading until its limit,
// never answers or creates again meanwhile, and only then reports the start as unknown, sending nothing.
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ordinary = { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };
let fixture: ReturnType<typeof nativeDraftFixture>, restore = () => {};
let operation: NativeCreationState, reads: NativeCreationState[] = [];
let reply: (body: NativeCreationReply) => NativeCreationState;
const unavailable = (): NativeCreationState => ({ operationId, directory, generation: null, revision: 0, phase: 'unavailable',
  expiresAt: operation.expiresAt, canInitialReady: false, clientRequestId: operation.clientRequestId });
const replies = () => fixture.requests.filter(r => new URL(r.url).pathname.endsWith('/reply'));
const record = () => nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations,
  useSessionUIStore.getState().newSessionDraft, fixture.runtimeA);
const failure = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code ?? String(error));
const send = () => {
  const input = useInputStore.getState();
  return useSessionUIStore.getState().sendMessage(input.pendingInputText ?? '', ordinary.model.providerID, ordinary.model.modelID,
    undefined, input.attachedFiles, undefined, input.pendingSyntheticParts ?? undefined, undefined, 'normal',
    { draftSnapshot: { ...useSessionUIStore.getState().newSessionDraft } });
};

function interactive(first: () => NativeCreationState) {
  fixture = nativeDraftFixture();
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  operation = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1 } });
  fixture.handlers.create = async request => {
    const sent = await request.clone().text();
    operation = { ...operation };
    if (sent) operation.clientRequestId = JSON.parse(sent).clientRequestId;
    return Response.json({ nativeCreation: first() }, { status: 202 });
  };
  reply = body => {
    operation = { ...operation, revision: operation.revision + 1, phase: body.action === 'trust' ? 'ready-required' : 'ready' };
    if (body.action === 'trust') { operation.native = { id: session.id, generation }; operation.canInitialReady = true; }
    return operation;
  };
  const inner = globalThis.fetch;
  restore = () => { globalThis.fetch = inner; };
  // SAFETY: the fixture fetch takes and returns exactly what fetch does; only Bun's extra static members differ.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: [operation] });
      if (path.endsWith('/reply')) return Response.json({ nativeCreation: reply(await request.json()) });
      if (path.endsWith(`/creation/${operation.operationId}`)) return Response.json({ nativeCreation: reads.shift() ?? operation });
      return Response.json({ ...session, nativeCreation: undefined, ordinary });
    }
    return inner(input, init);
  }) as typeof fetch;
}
afterEach(() => { restore(); restore = () => {}; fixture?.dispose(); sessionStorage.clear(); resetNativeDraftPage(); reads = []; });

test("an 'unavailable' create answer, then the real state: the start continues and the message is sent once", async () => {
  interactive(unavailable);
  reads = [unavailable()];
  await startNativeDraft([], async () => {}); await send();
  expect(fixture.creates()).toHaveLength(1);
  expect((await Promise.all(replies().map(r => r.clone().json()))).map(body => body.action)).toEqual(['trust', 'ready']);
  expect(fixture.prompts()).toHaveLength(1);
});

test("an 'unavailable' answer to the ready reply is re-read, never answered again; then the message is sent once", async () => {
  interactive(() => operation);
  const answer = reply;
  reply = body => { const next = answer(body); return body.action === 'ready' ? unavailable() : next; };
  reads = [unavailable()];
  await startNativeDraft([], async () => {}); await send();
  expect(fixture.creates()).toHaveLength(1);
  expect((await Promise.all(replies().map(r => r.clone().json()))).map(body => body.action)).toEqual(['trust', 'ready']);
  expect(fixture.prompts()).toHaveLength(1);
});

test("'unavailable' until the time limit: the start is unknown, nothing is sent, created or answered again", async () => {
  interactive(unavailable);
  reads = Array.from({ length: 1000 }, unavailable);
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  // It re-read until the limit, rather than giving up on the first 'unavailable'.
  expect(fixture.requests.filter(r => new URL(r.url).pathname.endsWith(`/creation/${operationId}`)).length).toBeGreaterThan(1);
  expect(record()?.status).toBe('pending');
});

for (const action of ['trust', 'ready'] as const) {
  test(`an 'unavailable' answer to the ${action} reply, then a read with no newer state: never answered again; unknown at the limit`, async () => {
    interactive(() => operation);
    const answer = reply;
    let answered = false;
    reply = body => {
      if (body.action !== action) return answer(body);
      answered = true; return unavailable(); // The reply's outcome is not known: the server state did not move.
    };
    reads = [unavailable()];
    const now = Date.now; let clock = now();
    Date.now = () => (clock += answered ? 30_000 : 0);
    try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
    const sent = (await Promise.all(replies().map(r => r.clone().json()))).map(body => body.action);
    expect(sent.filter(value => value === action)).toHaveLength(1);
    expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  });
}

test('"Start a new session anyway" detaches the unreadable start: Send starts a new one and sends once; the old never sends', async () => {
  interactive(unavailable);
  reads = Array.from({ length: 1000 }, unavailable);
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
  const old = { ...operation };
  startNativeDraftAgain();
  expect(record()).toBeNull();
  // A new start: a new operation and request id. The old one is still listed as running by the server.
  reads = [];
  operation = { ...operation, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 1, phase: 'awaiting-trust', clientRequestId: undefined };
  fixture.handlers.create = async request => {
    operation = { ...operation, clientRequestId: JSON.parse(await request.clone().text()).clientRequestId };
    return Response.json({ nativeCreation: operation }, { status: 202 });
  };
  await startNativeDraft([{ ...old, phase: 'starting' }], async () => {}); await send();
  const ids = await Promise.all(fixture.creates().map(async request => JSON.parse(await request.clone().text()).clientRequestId));
  expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
  expect(fixture.prompts()).toHaveLength(1);
  // A late 'ready' for the old start is never adopted or sent to.
  const late = { ...old, revision: 9, phase: 'ready' as const, native: { id: session.id, generation } };
  expect(await failure(resumeNativeCreation(late))).toBe('stale');
  expect(fixture.prompts()).toHaveLength(1);
});
