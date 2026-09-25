import { afterEach, expect, test } from 'bun:test';
import type { NativeCreationReply, NativeCreationState } from '@/lib/opencode/nativeCreation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from './input-store';
import { nativeCreationForDraft } from './native-draft-creation';
import { deferred, directory, nativeDraftFixture, session } from './native-draft-fixture';
import { startNativeDraft } from './native-draft-start';
import { useSessionUIStore } from './session-ui-store';

// smarty-code#126 (Paul's 2026-09-25 attempt): Send on a new-session draft starts the session, waits until it takes
// input and then sends once. A failed or unknown start sends nothing and keeps the message; nothing is sent twice.
let fixture: ReturnType<typeof nativeDraftFixture>, restore = () => {};
let operation: NativeCreationState, listed: NativeCreationState[], afterTrust: 'ready-required' | 'denied' = 'ready-required';
let detail: () => Promise<Response>, reply: (body: NativeCreationReply) => Promise<Response>;
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ordinary = { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };
const replies = () => fixture.requests.filter(r => new URL(r.url).pathname.endsWith('/reply'));
const record = () => nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations,
  useSessionUIStore.getState().newSessionDraft, fixture.runtimeA);
const noWait = async () => {};
const send = () => {
  const created = record(), input = useInputStore.getState();
  const model = created?.status === 'created' ? created.session.nativeCreation.model : ordinary.model;
  return useSessionUIStore.getState().sendMessage(input.pendingInputText ?? '', model.providerID, model.modelID, undefined,
    input.attachedFiles, undefined, input.pendingSyntheticParts ?? undefined, undefined, 'normal',
    { draftSnapshot: { ...useSessionUIStore.getState().newSessionDraft } });
};
/** What ChatInput's Send does: start (this module), then send only if the start settled. */
const sendOnce = async () => { await startNativeDraft(listed, noWait); await send(); };

function interactive() {
  fixture = nativeDraftFixture();
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  operation = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
  listed = []; afterTrust = 'ready-required';
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1 } });
  fixture.handlers.create = async () => { listed = [operation]; return Response.json({ nativeCreation: operation }, { status: 202 }); };
  detail = async () => Response.json({ ...session, nativeCreation: undefined, ordinary });
  reply = async body => {
    operation = { ...operation, revision: operation.revision + 1,
      phase: body.action === 'trust' ? afterTrust : body.action === 'ready' ? 'ready' : 'cancelled' };
    if (body.action === 'trust' && afterTrust === 'ready-required') { operation.native = { id: session.id, generation }; operation.canInitialReady = true; }
    return Response.json({ nativeCreation: operation });
  };
  const inner = globalThis.fetch;
  restore = () => { globalThis.fetch = inner; };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: listed });
      if (path.endsWith('/reply')) return reply(await request.json());
      if (path.endsWith(`/creation/${operationId}`)) return Response.json({ nativeCreation: operation });
      return detail();
    }
    return inner(input, init);
  }) as typeof fetch;
}
afterEach(() => { restore(); restore = () => {}; fixture?.dispose(); });

test('one Send starts the session (trust and first input answered), then sends the message once', async () => {
  interactive();
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1);
  expect(await Promise.all(replies().map(r => r.clone().json()))).toEqual([
    { action: 'trust', generation: endpoint, revision: 1 },
    { action: 'ready', generation: endpoint, revision: 2, native: { id: session.id, generation } },
  ]);
  expect(fixture.prompts()).toHaveLength(1);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});

test('a session that starts ready at once (create-only server) is sent to once, with no replies', async () => {
  fixture = nativeDraftFixture(); listed = [];
  await startNativeDraft([], noWait); await send();
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(1);
});

test('a start refused before the create request sends nothing, keeps the message, and Send may start it later', async () => {
  fixture = nativeDraftFixture(); listed = [];
  fixture.handlers.health = async () => Response.json({ message: 'down' }, { status: 503 });
  await expect(startNativeDraft([], noWait)).rejects.toMatchObject({ code: 'unavailable' });
  expect(fixture.creates()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  expect(useInputStore.getState().pendingInputText).toBe('Keep @notes.md');
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } });
  await startNativeDraft([], noWait); await send();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
});

test('an unknown start outcome sends nothing and is never created or sent again', async () => {
  fixture = nativeDraftFixture(); listed = [];
  fixture.handlers.create = async () => { throw new Error('connection reset after the request'); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(startNativeDraft([], noWait)).rejects.toMatchObject({ code: 'unknown' });
  }
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useInputStore.getState().pendingInputText).toBe('Keep @notes.md');
});

test('a declined start sends nothing; the next Send starts a new session once', async () => {
  interactive(); afterTrust = 'denied';
  await expect(startNativeDraft(listed, noWait)).rejects.toMatchObject({ code: 'stopped' });
  expect(fixture.prompts()).toHaveLength(0);
  afterTrust = 'ready-required';
  operation = { ...operation, phase: 'awaiting-trust', revision: 1, native: undefined, canInitialReady: false };
  await startNativeDraft([], noWait); await send();
  expect(fixture.creates()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
});

test('a session that cannot take first input from the browser sends nothing', async () => {
  interactive();
  reply = async () => { operation = { ...operation, revision: 2, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: false };
    return Response.json({ nativeCreation: operation }); };
  await expect(startNativeDraft(listed, noWait)).rejects.toMatchObject({ code: 'notReady' });
  expect(replies()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
});

test('a second Send while the first is starting is refused; one create, one reply, nothing sent twice', async () => {
  interactive();
  const held = deferred<Response>(); reply = () => held.promise;
  const first = startNativeDraft(listed, noWait);
  await expect(startNativeDraft(listed, noWait)).rejects.toMatchObject({ code: 'sending' });
  while (replies().length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  operation = { ...operation, revision: 2, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true };
  held.resolve(Response.json({ nativeCreation: operation }));
  reply = async () => { operation = { ...operation, revision: 3, phase: 'ready' }; return Response.json({ nativeCreation: operation }); };
  await first; await send();
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
});

test('an earlier start in this project that is still running is continued, not created again', async () => {
  interactive(); listed = [operation];
  await sendOnce();
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
});

test('a start that is still running after the time limit sends nothing; a later Send continues it', async () => {
  interactive(); operation.expiresAt = Date.now() + 1e9;
  reply = async () => { operation = { ...operation, revision: 2, phase: 'starting' }; return Response.json({ nativeCreation: operation }); };
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { await expect(startNativeDraft(listed, noWait)).rejects.toMatchObject({ code: 'required' }); } finally { Date.now = now; }
  expect(fixture.prompts()).toHaveLength(0); expect(record()?.status).toBe('pending');
  operation = { ...operation, revision: 3, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true };
  reply = async () => { operation = { ...operation, revision: 4, phase: 'ready' }; return Response.json({ nativeCreation: operation }); };
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
});

for (const change of ['runtime', 'draft', 'project'] as const) {
  test(`a ${change} change while the start is held sends nothing and selects nothing`, async () => {
    interactive();
    const held = deferred<Response>(); reply = () => held.promise;
    const pending = startNativeDraft(listed, noWait);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (change === 'runtime') fixture.switchRuntime('other-runtime');
    else if (change === 'draft') fixture.target('b', '/native-project-b');
    else useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unavailable' });
    held.resolve(Response.json({ nativeCreation: { ...operation, revision: 2, phase: 'ready-required',
      native: { id: session.id, generation }, canInitialReady: true } }));
    await expect(pending).rejects.toBeDefined();
    expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  });
}

test('a stock server (no session start) leaves Send to its ordinary path', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.health = async () => Response.json({ healthy: true });
  await startNativeDraft([], noWait);
  expect(fixture.creates()).toHaveLength(0); expect(record()).toBeNull();
});
