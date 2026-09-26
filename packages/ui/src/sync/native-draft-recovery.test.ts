import { afterEach, expect, test } from 'bun:test';
import { claimChatDraftOwnership, createChatDraftIdentity, writeChatDraft } from '@/lib/chatDraftPersistence';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { directory, session } from './native-draft-fixture';
import { composerSend, failure, fx, h, heldLocks, interactive, record, repliedActions, resetInteractive, sentMark, unavailable } from './native-draft-interactive';
import { refreshNativeCreation } from './native-draft-control';
import { ownNativeRequestId, resetNativeDraftPage, startNativeDraft, startNativeDraftInstead } from './native-draft-start';
import { resetSentStartsForPage, resolveSentStart, sentStartLocks } from './native-draft-sent';
import { useSessionUIStore } from './session-ui-store';
import { assertNativeDraftReady, beginNativeDraftSend, prepareNativeDraftSend } from './native-draft-send';
import { preparedNativeDraft } from './native-draft-creation';

// Astra pre-check of the native-draft-start PR (smarty-code#117, #340, F11): recovery after a reload, a refusal or a lost
// response never answers twice, never strands the draft, and never sends another tab's text again.
afterEach(resetInteractive);
/** A reload of this tab: page memory goes; sessionStorage stays; the startup open restores the draft. */
const reload = () => { resetNativeDraftPage(); resetSentStartsForPage();
  useSessionUIStore.setState(state => ({ nativeDraftCreations: new Map(), newSessionDraft: { ...state.newSessionDraft, restored: true } })); };
/** Runs Send's start with the clock jumping, so a start that stays unsettled reaches its limit at once. */
async function atLimit(work: () => Promise<void>): Promise<string> {
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { return await failure(work()); } finally { Date.now = now; }
}
/** The owner keeps reporting ready-required after its first-input answer (a newer revision each read). */
function stuckReadyRequired() {
  const answer = h.reply;
  h.reply = body => { const next = answer(body); return body.action === 'ready' ? (h.operation = { ...next, phase: 'ready-required', canInitialReady: true }) : next; };
}

test('the ready answer is POSTed once for an operation, also after a reload of this tab', async () => {
  interactive(() => h.operation);
  h.operation.expiresAt = Date.now() + 1e12; // Only Send's own limit is reached here.
  stuckReadyRequired();
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('required');
  reload();
  expect(await atLimit(() => startNativeDraft([h.operation], async () => {}))).toBe('required');
  expect(await repliedActions()).toEqual(['trust', 'ready']);
});

test('a ready answer the server definitely refused (409) may be answered again after a re-read', async () => {
  interactive(() => h.operation);
  const answer = h.reply;
  let refuse = true;
  h.reply = body => {
    if (body.action === 'ready' && refuse) { refuse = false; throw new Error('refused'); }
    return answer(body);
  };
  const inner = globalThis.fetch;
  // SAFETY: the wrapper takes and returns exactly what fetch does; only Bun's extra static members differ.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await inner(input, init); }
    catch { return Response.json({ name: 'APIError', data: { message: 'Native creation state changed; re-read without replay' } }, { status: 409 }); }
  }) as typeof fetch;
  expect(await failure(startNativeDraft([], async () => {}))).not.toBe('resolved');
  await refreshNativeCreation();
  await startNativeDraft([], async () => {});
  expect(await repliedActions()).toEqual(['trust', 'ready', 'ready']);
  expect(record()?.status).toBe('created');
});

test('an abandon whose answer was lost: a re-read accepts the server\'s cancelled state, so the draft is not stranded', async () => {
  interactive(() => h.operation); // Readable at first (a real generation), then its trust answer's outcome is unknown.
  h.operation.expiresAt = Date.now() + 1e12;
  h.reply = unavailable;
  h.reads = Array.from({ length: 1000 }, unavailable);
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('unknown');
  h.abandon = () => { throw new Error('connection reset'); };
  expect(await failure(startNativeDraftInstead())).not.toBe('resolved');
  // The server did abandon it: it now reports the operation cancelled, with no generation (#340).
  const cancelled: NativeCreationState = { ...unavailable(), phase: 'cancelled' };
  h.reads = [cancelled];
  await refreshNativeCreation();
  const now = record();
  expect(now?.status === 'pending' && now.operation.phase).toBe('cancelled');
  expect(now?.status === 'pending' && now.error).toBeFalsy();
});

test('a project whose draft text another tab sent is resolved before a new start; a pending one starts nothing', async () => {
  interactive(() => h.operation);
  localStorage.setItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`,
    JSON.stringify({ clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }));
  h.operation = { ...h.operation, clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  // This tab still holds a copy of that text in its draft.
  const identity = createChatDraftIdentity(fx().runtimeA, directory, null, useSessionUIStore.getState().newSessionDraft.draftId);
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'hello', []);
  expect(await failure(startNativeDraft([], async () => {}))).toBe('elsewhere');
  expect(fx().creates()).toHaveLength(0);
});

test('after a reload that first lists the start unavailable, ready is still answered once', async () => {
  interactive(() => h.operation);
  h.operation.expiresAt = Date.now() + 1e12;
  stuckReadyRequired();
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('required');
  reload();
  let once = true; // The reloaded page's listing cannot read the owner yet (no generation); the read after it can.
  h.listed = () => (once ? (once = false, [unavailable()]) : [h.operation]);
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('required');
  expect(await repliedActions()).toEqual(['trust', 'ready']);
});

test('the sending lock is held only while this page is in a Send for its request, also after a reload', async () => {
  interactive(() => h.operation);
  h.operation.expiresAt = Date.now() + 1e12;
  const during: string[][] = [];
  h.reply = body => { during.push([...heldLocks]); return body.action === 'trust' ? unavailable() : h.operation; };
  h.reads = Array.from({ length: 1000 }, unavailable);
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('unknown');
  const id = h.operation.clientRequestId!;
  expect(during).toEqual([[`oc.nativeCreation.sending:${id}`]]);
  await new Promise(done => setTimeout(done, 1));
  expect([...heldLocks]).toEqual([]); // The Send ended: another tab may now read what became of it.
  reload();
  const resumed: string[][] = [];
  h.reads = Object.assign([], { shift: () => { resumed.push([...heldLocks]); return unavailable(); } });
  h.listed = () => [unavailable()];
  expect(await atLimit(() => startNativeDraft([], async () => {}))).toBe('unknown');
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.every(names => names.includes(`oc.nativeCreation.sending:${id}`))).toBe(true);
  await new Promise(done => setTimeout(done, 1));
  expect([...heldLocks]).toEqual([]);
});

test('a Send holds its request\'s lock only while it starts and while its prompt POST is in flight, retries included', async () => {
  interactive(() => h.operation);
  await startNativeDraft([], async () => {});
  const id = h.operation.clientRequestId!;
  expect([...heldLocks]).toEqual([]); // Between the start and the prompt, other tabs read the text as unknown.
  const during: string[][] = [];
  let refuse = true;
  fx().handlers.prompt = async () => {
    during.push([...heldLocks]);
    if (refuse) { refuse = false; return Response.json({ name: 'APIError', data: { message: 'busy' } }, { status: 409 }); }
    return new Response(null, { status: 204 });
  };
  expect(await failure(composerSend())).not.toBe('resolved');
  await new Promise(done => setTimeout(done, 1));
  expect([...heldLocks]).toEqual([]);
  await composerSend(); // The explicit retry to the same started session carries the same request.
  await new Promise(done => setTimeout(done, 1));
  expect(during).toEqual([[`oc.nativeCreation.sending:${id}`], [`oc.nativeCreation.sending:${id}`]]);
  expect([...heldLocks]).toEqual([]);
  expect(JSON.parse(localStorage.getItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`)!))
    .toMatchObject({ clientRequestId: id, admitted: true });
});

test('after a Send is admitted, New session in the same project starts at once; the mark carries the submitted text', async () => {
  interactive(() => h.operation);
  await startNativeDraft([], async () => {}); await composerSend('actual message A');
  const first = h.operation;
  expect(JSON.parse(localStorage.getItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`)!))
    .toMatchObject({ clientRequestId: first.clientRequestId, admitted: true, text: 'actual message A' });
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory });
  h.operation = { ...first, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 1, phase: 'awaiting-trust',
    clientRequestId: undefined, native: undefined, canInitialReady: false };
  await startNativeDraft([{ ...first, phase: 'ready' }], async () => {});
  expect(fx().creates()).toHaveLength(2);
});

// Astra review of #220 (P1): an accepted start recovered by its request id takes the durable sent mark before its text
// is sent, so a page closed after the prompt is admitted (before its answer) never offers that text as a new draft.
test('lost create response, recovery, prompt admitted, page closed before its answer: the reload never sends the text again', async () => {
  interactive(() => h.operation);
  const created = fx().handlers.create;
  fx().handlers.create = async request => { await created(request); throw new Error('response lost'); };
  const identity = () => createChatDraftIdentity(fx().runtimeA, directory, null, useSessionUIStore.getState().newSessionDraft.draftId);
  claimChatDraftOwnership(identity()); writeChatDraft(identity(), 'hello', []);
  expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown');
  const id = h.operation.clientRequestId!;
  expect(sentMark()).toBeNull(); // The 202 never arrived: nothing proved the start accepted yet.
  await startNativeDraft([], async () => {}); // Send again: recovery by this tab's id, then ready.
  expect(JSON.parse(sentMark()!)).toEqual({ clientRequestId: id }); // Marked before the prompt goes.
  let admitted = () => {};
  fx().handlers.prompt = () => new Promise(() => { admitted(); }); // The server takes the prompt; its answer never arrives.
  const posted = new Promise<void>(done => { admitted = done; });
  void composerSend('hello').catch(() => undefined);
  await posted;
  reload(); // The page closes before the answer: its Send never admitted the mark.
  const draft = useSessionUIStore.getState().newSessionDraft;
  h.listed = () => [{ ...h.operation, phase: 'ready' }];
  const outcome = await resolveSentStart(fx().runtimeA, directory, draft.draftId, ownNativeRequestId(draft, fx().runtimeA));
  expect(sentStartLocks(outcome)).toBe(true); // Read-only: not a draft to send again.
  expect(await failure(startNativeDraft([], async () => {}))).toBe('elsewhere');
  expect(fx().creates()).toHaveLength(1); expect(fx().prompts()).toHaveLength(1);
});

test('recovery never replaces another request\'s live mark in the same project; it sends nothing', async () => {
  interactive(() => h.operation);
  const created = fx().handlers.create;
  fx().handlers.create = async request => { await created(request); throw new Error('response lost'); };
  expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown');
  const other = JSON.stringify({ clientRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  localStorage.setItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`, other);
  expect(await failure(startNativeDraft([], async () => {}))).toBe('elsewhere');
  expect(sentMark()).toBe(other); expect(await repliedActions()).toEqual([]);
});

test('a start still held in memory (Send left for another project, then came back) is marked before its text goes', async () => {
  interactive(() => h.operation);
  const created = fx().handlers.create;
  let arrive = () => {};
  const gate = new Promise<void>(done => { arrive = done; });
  fx().handlers.create = async request => { await gate; return created(request); };
  const identity = () => createChatDraftIdentity(fx().runtimeA, directory, null, useSessionUIStore.getState().newSessionDraft.draftId);
  claimChatDraftOwnership(identity()); writeChatDraft(identity(), 'hello', []);
  const leaving = failure(startNativeDraft([], async () => {}));
  await new Promise(done => setTimeout(done, 5));
  fx().target('b', '/native-project-b'); // The project selector: the same draft, another project.
  arrive();
  expect(await leaving).toBe('stale');
  fx().target('a', directory);
  expect(record()?.status).toBe('pending'); // The accepted start is still held for this draft.
  await startNativeDraft([], async () => {});
  expect(JSON.parse(sentMark()!)).toEqual({ clientRequestId: h.operation.clientRequestId });
  let admitted = () => {};
  fx().handlers.prompt = () => new Promise(() => { admitted(); });
  const posted = new Promise<void>(done => { admitted = done; });
  void composerSend('hello').catch(() => undefined);
  await posted;
  reload();
  h.listed = () => [{ ...h.operation, phase: 'ready' }];
  expect(await failure(startNativeDraft([], async () => {}))).toBe('elsewhere');
  expect(fx().creates()).toHaveLength(1); expect(fx().prompts()).toHaveLength(1);
});

// Pre-check round 2: the durable mark is required at the send boundary itself (every prompt POST, retries too), not
// only on the start paths: a start that needed its terminal's readiness forgot its request id and its mark.
test('a start made ready in its terminal (notReady first) is marked when its text goes', async () => {
  interactive(() => h.operation);
  h.reply = () => (h.operation = { ...h.operation, revision: h.operation.revision + 1, phase: 'ready-required',
    native: { id: session.id, generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, canInitialReady: false });
  expect(await failure(startNativeDraft([], async () => {}))).toBe('notReady');
  const id = h.operation.clientRequestId!;
  expect(sentMark()).toBeNull(); // Nothing was sent: the text is this page's own draft again.
  h.operation = { ...h.operation, revision: h.operation.revision + 1, phase: 'ready' }; // Ready in its terminal.
  await refreshNativeCreation();
  expect(record()?.status).toBe('created');
  const marks: (string | null)[] = [];
  fx().handlers.prompt = async () => { marks.push(sentMark()); return new Response(null, { status: 204 }); };
  await composerSend('hello');
  expect(marks).toHaveLength(1);
  expect(JSON.parse(marks[0]!)).toEqual({ clientRequestId: id });
});

test('a mark the browser refuses to store blocks the prompt: nothing is sent and the Send says why', async () => {
  interactive(() => h.operation);
  await startNativeDraft([], async () => {});
  localStorage.removeItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`);
  const setItem = localStorage.setItem;
  localStorage.setItem = (key: string, value: string) => {
    if (key.startsWith('oc.nativeCreation.sent:')) throw new DOMException('full', 'QuotaExceededError');
    setItem.call(localStorage, key, value);
  };
  try { expect(await failure(composerSend('hello'))).toBe('storage'); } finally { localStorage.setItem = setItem; }
  await new Promise(done => setTimeout(done, 1));
  expect(fx().prompts()).toHaveLength(0); expect([...heldLocks]).toEqual([]);
  await composerSend('hello'); // Storage works again: the same Send goes once.
  expect(fx().prompts()).toHaveLength(1);
});

test('the mark is checked again immediately before the POST: one removed meanwhile is written again', async () => {
  interactive(() => h.operation);
  await startNativeDraft([], async () => {});
  const draft = useSessionUIStore.getState().newSessionDraft;
  const intent = await prepareNativeDraftSend(draft, (await preparedNativeDraft(draft))!);
  const release = beginNativeDraftSend(intent);
  try {
    localStorage.removeItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`); // Another tab.
    assertNativeDraftReady(intent); // The store's beforeDispatch.
    expect(JSON.parse(sentMark()!)).toEqual({ clientRequestId: intent.clientRequestId });
  } finally { release(); }
});

test('a refused prompt, then another project and back: this page\'s own mark never locks its composer', async () => {
  interactive(() => h.operation);
  await startNativeDraft([], async () => {});
  fx().handlers.prompt = async () => Response.json({ name: 'APIError', data: { message: 'busy' } }, { status: 409 });
  expect(await failure(composerSend('hello'))).not.toBe('resolved');
  fx().target('b', '/native-project-b');
  fx().target('a', directory);
  const draft = useSessionUIStore.getState().newSessionDraft;
  const identity = createChatDraftIdentity(fx().runtimeA, directory, null, draft.draftId);
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'hello', []); // The composer still holds the text.
  expect(await resolveSentStart(fx().runtimeA, directory, draft.draftId, ownNativeRequestId(draft, fx().runtimeA))).toBeNull();
  fx().handlers.prompt = async () => new Response(null, { status: 204 });
  await composerSend('hello');
  expect(fx().prompts()).toHaveLength(2);
});
