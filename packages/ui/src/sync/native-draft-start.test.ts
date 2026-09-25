import { afterEach, expect, test } from 'bun:test';
import type { NativeCreationReply, NativeCreationState } from '@/lib/opencode/nativeCreation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from './input-store';
import { nativeCreationForDraft } from './native-draft-creation';
import { deferred, directory, nativeDraftFixture, session } from './native-draft-fixture';
import { resetNativeDraftPage, startNativeDraft, startNativeDraftAgain } from './native-draft-start';
import { useSessionUIStore } from './session-ui-store';
import { opencodeClient } from '@/lib/opencode/client';

// Bun has no sessionStorage; the start keeps this tab's create request id there. clear() models another window.
const tab = new Map<string, string>();
if (typeof globalThis.sessionStorage === 'undefined') Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); },
  removeItem: (key: string) => { tab.delete(key); }, clear: () => { tab.clear(); } } });


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
/** The rejection's code, or 'resolved' (the repo's expect type declares no rejects.toMatchObject). */
const failure = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code ?? String(error));
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
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1 } });
  fixture.handlers.create = async request => {
    const sent = await request.clone().text();
    operation = { ...operation, ...(sent ? { clientRequestId: JSON.parse(sent).clientRequestId } : {}) };
    listed = [operation]; return Response.json({ nativeCreation: operation }, { status: 202 });
  };
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
afterEach(() => { restore(); restore = () => {}; fixture?.dispose(); sessionStorage.clear(); resetNativeDraftPage(); });

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
  expect(await failure(startNativeDraft([], noWait))).toBe('unavailable');
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
    expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  }
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useInputStore.getState().pendingInputText).toBe('Keep @notes.md');
});

test('a declined start sends nothing; the next Send starts a new session once', async () => {
  interactive(); afterTrust = 'denied';
  expect(await failure(startNativeDraft(listed, noWait))).toBe('stopped');
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
  expect(await failure(startNativeDraft(listed, noWait))).toBe('notReady');
  expect(replies()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
});

test('a second Send while the first is starting is refused; one create, one reply, nothing sent twice', async () => {
  interactive();
  const held = deferred<Response>(); reply = () => held.promise;
  const first = startNativeDraft(listed, noWait);
  expect(await failure(startNativeDraft(listed, noWait))).toBe('sending');
  while (replies().length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  operation = { ...operation, revision: 2, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true };
  held.resolve(Response.json({ nativeCreation: operation }));
  reply = async () => { operation = { ...operation, revision: 3, phase: 'ready' }; return Response.json({ nativeCreation: operation }); };
  await first; await send();
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
});

test('another start in this project (another window, device or draft) is never taken over', async () => {
  interactive(); listed = [operation];
  expect(await failure(startNativeDraft(listed, noWait))).toBe('elsewhere');
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});

test('a start that is still running after the time limit sends nothing; a later Send continues it', async () => {
  interactive(); operation.expiresAt = Date.now() + 1e9;
  reply = async () => { operation = { ...operation, revision: 2, phase: 'starting' }; return Response.json({ nativeCreation: operation }); };
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { expect(await failure(startNativeDraft(listed, noWait))).toBe('required'); } finally { Date.now = now; }
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
    expect(await failure(pending)).not.toBe('resolved');
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

/** This tab's saved create request ids (the draft tokens beside them are not requests). */
const requests = () => [...tab].filter(([key]) => key.startsWith('oc.nativeCreation.request:')).map(([, id]) => id);
const clearPage = () => { useSessionUIStore.setState({ nativeDraftCreations: new Map() }); resetNativeDraftPage(); };
const loseResponse = () => { const created = fixture.handlers.create;
  fixture.handlers.create = async request => { await created(request); throw new Error('response lost'); }; };
const sentIds = async () => Promise.all(fixture.creates().map(async request => (await request.clone().text()) || 'none'));

test('a lost create response: Check again only reads; Send continues the operation with this tab\'s exact id; one create', async () => {
  interactive(); loseResponse();
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  const id = JSON.parse((await sentIds())[0]).clientRequestId;
  expect(typeof id).toBe('string');
  // Check again re-reads the list, which shows the operation with this id. The read sends no choice and no message.
  expect((await opencodeClient.listNativeCreations(directory)).map(entry => entry.clientRequestId)).toEqual([id]);
  expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
  expect(replies().map(request => new URL(request.url).pathname.split('/').at(-2))).toEqual([operationId, operationId]);
});

test('a lost create response with no id match (a competing client\'s start) is never adopted', async () => {
  interactive();
  fixture.handlers.create = async () => { listed = [{ ...operation, clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }];
    throw new Error('response lost'); };
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  expect(await failure(startNativeDraft(listed, noWait))).toBe('unknown');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
});

test('a gateway without the request id gets no id and a lost create is never adopted', async () => {
  interactive(); loseResponse();
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1 } });
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  expect(await sentIds()).toEqual(['none']);
  expect(await failure(startNativeDraft(listed, noWait))).toBe('unknown');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});

test('two windows: B never resumes A\'s start; a reload of A continues it by its exact id', async () => {
  interactive(); loseResponse();
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  const aTab = new Map(tab);
  // Window B: same origin, its own sessionStorage and page memory.
  sessionStorage.clear(); clearPage();
  expect(await failure(startNativeDraft(listed, noWait))).toBe('elsewhere');
  expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  // Window A reloads: page memory is gone, its tab storage stays.
  for (const [key, value] of aTab) sessionStorage.setItem(key, value);
  clearPage();
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
  expect(replies().map(request => new URL(request.url).pathname.split('/').at(-2))).toEqual([operationId, operationId]);
});

for (const change of ['runtime', 'draft', 'project'] as const) {
  test(`a ${change} change while the capability read is held creates nothing`, async () => {
    fixture = nativeDraftFixture(); listed = [];
    const held = deferred<Response>(); fixture.handlers.health = () => held.promise;
    const pending = startNativeDraft([], noWait);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (change === 'runtime') fixture.switchRuntime('other-runtime');
    else if (change === 'draft') fixture.target('b', '/native-project-b');
    else useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unavailable' });
    held.resolve(Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } }));
    expect(await failure(pending)).not.toBe('resolved');
    expect(fixture.creates()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  });
}

test('a saved id blocks a second create after a reload, even while the list is empty or fails; its exact match recovers later', async () => {
  interactive();
  // The create reached no list yet: its operation is not listed (the server has not recorded it, or the read lags).
  fixture.handlers.create = async request => { const sent = await request.clone().text();
    operation = { ...operation, clientRequestId: JSON.parse(sent).clientRequestId }; throw new Error('response lost'); };
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  const saved = requests();
  expect(saved).toHaveLength(1);
  clearPage(); // reload: page memory gone, tab storage kept
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown'); // empty list: not proof of anything
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(new Request(input, init).url).pathname.endsWith('/creation')
    ? Response.json({ message: 'down' }, { status: 503 }) : inner(input, init)) as typeof fetch;
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown'); // failed read: still no create
  globalThis.fetch = inner;
  expect(fixture.creates()).toHaveLength(1); expect(requests()).toEqual(saved);
  listed = [operation]; // the server now lists the original start, with the original id
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
  expect(JSON.parse(await fixture.creates()[0].clone().text()).clientRequestId).toBe(saved[0]);
});

test('a saved id whose start the server reports stopped is cleared; the next Send starts once with a new id', async () => {
  interactive(); loseResponse();
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  listed = [{ ...operation, phase: 'expired' }];
  clearPage();
  operation = { ...operation, phase: 'awaiting-trust', clientRequestId: undefined };
  fixture.handlers.create = async request => { const sent = await request.clone().text();
    operation = { ...operation, clientRequestId: JSON.parse(sent).clientRequestId }; listed = [operation];
    return Response.json({ nativeCreation: operation }, { status: 202 }); };
  await startNativeDraft([], noWait); await send();
  expect(fixture.creates()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
  const [first, second] = await sentIds();
  expect(first).not.toBe(second);
});

test('the explicit escape from an unknown start clears the saved id and starts exactly one new session', async () => {
  interactive();
  fixture.handlers.create = async () => { throw new Error('response lost'); }; // never listed: the outcome stays unknown
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  clearPage();
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  startNativeDraftAgain();
  expect(requests()).toEqual([]);
  operation = { ...operation, phase: 'awaiting-trust', revision: 1, native: undefined, canInitialReady: false, clientRequestId: undefined };
  fixture.handlers.create = async request => { const sent = await request.clone().text();
    operation = { ...operation, clientRequestId: JSON.parse(sent).clientRequestId }; listed = [operation];
    return Response.json({ nativeCreation: operation }, { status: 202 }); };
  listed = [];
  await startNativeDraft([], noWait); await send();
  expect(fixture.creates()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(1);
  const [first, second] = await sentIds();
  expect(first).not.toBe(second);
});

test('a reload (a new draft id for the same project) still finds the saved id and creates no second session', async () => {
  interactive();
  fixture.handlers.create = async request => { const sent = await request.clone().text();
    operation = { ...operation, clientRequestId: JSON.parse(sent).clientRequestId }; throw new Error('response lost'); };
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  // Reload: page memory is gone and the draft counter restarts, so the draft id differs; tab storage remains.
  clearPage();
  useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, draftId: state.newSessionDraft.draftId + 1000 } }));
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  expect(fixture.creates()).toHaveLength(1);
  listed = [operation];
  await sendOnce();
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(1);
});

test('an explicit new draft in the same project never resumes, answers or sends to the earlier draft\'s start', async () => {
  interactive();
  fixture.handlers.create = async request => { const sent = await request.clone().text();
    operation = { ...operation, clientRequestId: JSON.parse(sent).clientRequestId }; throw new Error('response lost'); };
  expect(await failure(startNativeDraft([], noWait))).toBe('unknown');
  // New session B, same page and project: a new draft id, and A's start is now readable.
  useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, draftId: state.newSessionDraft.draftId + 1 } }));
  listed = [operation];
  expect(await failure(startNativeDraft(listed, noWait))).toBe('elsewhere');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  // Even after a reload, the restored draft is B (the latest), not A: A's start is still never adopted.
  clearPage();
  useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, draftId: state.newSessionDraft.draftId + 1000 } }));
  expect(await failure(startNativeDraft(listed, noWait))).toBe('elsewhere');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});
