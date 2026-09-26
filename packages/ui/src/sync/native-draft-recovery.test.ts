import { afterEach, expect, test } from 'bun:test';
import { claimChatDraftOwnership, createChatDraftIdentity, writeChatDraft } from '@/lib/chatDraftPersistence';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { directory } from './native-draft-fixture';
import { composerSend, failure, fx, h, heldLocks, interactive, record, repliedActions, resetInteractive, unavailable } from './native-draft-interactive';
import { refreshNativeCreation } from './native-draft-control';
import { resetNativeDraftPage, startNativeDraft, startNativeDraftInstead } from './native-draft-start';
import { resetSentStartsForPage } from './native-draft-sent';
import { useSessionUIStore } from './session-ui-store';

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
