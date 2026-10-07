import { expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory as A, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { sendAdmission } from '@/sync/send-admission';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { toast } from '@/components/ui';
import type { ExternalToast } from 'sonner';
import { z } from 'zod';
const actionSchema = z.object({ label: z.string(), onClick: z.function() });
import type React from 'react';

// Astra round 5 P1 (openchamber#549, smarty-code#1427): an ambiguous ordinary Send must not fence the session for good.
// The actual composer: the lost request's text comes back, an unrelated Send waits, the unchanged re-send goes with the
// original client ID, its answer releases the session, and a later deliberate Send is a new message.
const row = { ...session, nativeRuntime: 'ordinary', herdrState: 'idle', herdrPaneLive: true,
  ordinary: { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } };
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await act(async () => { await sleep(25); });
  expect(ok()).toBe(true);
};

test('an ambiguous Send: its unchanged re-send keeps the client ID, settles the outcome, and frees the session', async () => {
  const info = spyOn(toast, 'info').mockImplementation(() => 'test-toast');
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => ++posts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await c.replace('The lost message'); await c.submit();
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id) !== undefined);
    await until(() => c.text() === 'The lost message'); // Given back by the watchdog.
    // Let the first request's own failure settle (its confirmation read), so the outcome is unknown, not in flight. A
    // re-send while it is still in flight is refused like any other (covered in send-admission.test.ts).
    await until(() => sendAdmission.unconfirmed(c.runtimeA, session.id)?.inFlight === false);
    // Anything else waits for that outcome.
    const before = info.mock.calls.length;
    await c.replace('An unrelated message'); await c.submit(); await act(async () => { await sleep(50); });
    expect(posts).toBe(1);
    expect(info.mock.calls.slice(before).map(call => String(call[0]))).toContain('Waiting for your last message to be confirmed.');
    // The same message goes again with its original client ID; the gateway's answer settles it.
    await c.replace('The lost message'); await c.submit();
    await until(() => posts >= 2);
    expect(posts).toBe(2);
    const [first, retry] = await Promise.all(c.prompts().map(request => request.clone().json()));
    expect(retry.messageID).toBe(first.messageID);
    await until(() => sendAdmission.unconfirmed(c.runtimeA, session.id) === undefined);
    // A later deliberate Send is a new message.
    await c.replace('A new message'); await c.submit();
    await until(() => posts === 3);
    const third = await c.prompts()[2].clone().json();
    expect(third.messageID).not.toBe(first.messageID);
  } finally { sendUnconfirmed.ms = was; info.mockRestore(); await c.dispose(); }
}, 30_000);

// Source audit of a5716127, P1: the route sends prepared text (snippets expanded), while a retry shows the composer's own
// text. The unresolved Send is recognized by the composer's text, so its retry still goes with the original client ID.
test('a prepared (snippet-expanded) Send is still recognized by its composer text on retry', async () => {
  const { useSnippetsStore } = await import('@/stores/useSnippetsStore');
  const realExpand = useSnippetsStore.getState().expandText;
  useSnippetsStore.setState({ expandText: async (text: string) => `Expanded: ${text}` });
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => ++posts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await c.replace('#greet the team'); await c.submit();
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id) !== undefined);
    await until(() => c.text() === '#greet the team');
    await until(() => sendAdmission.unconfirmed(c.runtimeA, session.id)?.inFlight === false);
    await c.replace('#greet the team'); await c.submit();
    await until(() => posts === 2);
    const [first, retry] = await Promise.all(c.prompts().map(request => request.clone().json()));
    expect(first.parts.map((part: { text?: string }) => part.text)).toContain('Expanded: #greet the team');
    expect(retry.messageID).toBe(first.messageID);
    await until(() => sendAdmission.unconfirmed(c.runtimeA, session.id) === undefined);
  } finally { useSnippetsStore.setState({ expandText: realExpand }); sendUnconfirmed.ms = was; await c.dispose(); }
}, 30_000);

// smarty-code#1427 (code-lead decision a and b): an unresolved Send leaves no prompt text in localStorage, and the person
// can choose "Discard and send anyway" after a confirm that names the risk. That clears the fence and sends exactly one
// new message; dismissing the notices sends nothing.
test('discard and send anyway: an explicit confirm clears the fence and sends one new message; no prompt text is stored', async () => {
  const actions: Array<{ label: string; onClick: () => void }> = [];
  // Records each notice's action button: a label and a click, as sonner renders it.
  const record = (_message: React.ReactNode, data?: ExternalToast) => {
    const parsed = actionSchema.safeParse(data?.action);
    if (parsed.success) actions.push({ label: parsed.data.label, onClick: () => parsed.data.onClick() });
    return 'test-toast';
  };
  const info = spyOn(toast, 'info').mockImplementation(record);
  const warning = spyOn(toast, 'warning').mockImplementation(record);
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => ++posts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await c.replace('A private lost prompt'); await c.submit();
    // The first request's own failure settles (its confirmation read): its outcome is unknown, no longer in flight.
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id)?.inFlight === false);
    // The admission records only (the input-history recall store keeps submitted text by design, as it did before).
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? '').filter(key => key.startsWith('oc.send.'));
    expect(keys).toHaveLength(1);
    const stored = keys.map(key => `${key}=${localStorage.getItem(key)}`).join('\n');
    expect(stored).toContain(sendAdmission.unconfirmed(c.runtimeA, session.id)!.messageID);
    expect(stored).not.toContain('A private lost prompt');
    // A different message waits; its notice offers the risky choice, which asks again before anything goes.
    await c.replace('A different message'); await c.submit(); await act(async () => { await sleep(50); });
    expect(posts).toBe(1);
    expect(actions.map(action => action.label)).toEqual(['Discard and send anyway']);
    await act(async () => { actions[0].onClick(); await sleep(50); });
    expect(posts).toBe(1); // The first choice only opens the confirm.
    expect(actions.map(action => action.label)).toEqual(['Discard and send anyway', 'Send anyway']);
    await act(async () => { actions[1].onClick(); });
    await until(() => posts === 2);
    await act(async () => { await sleep(100); });
    expect(posts).toBe(2);
    const [first, second] = await Promise.all(c.prompts().map(request => request.clone().json()));
    expect(second.messageID).not.toBe(first.messageID);
    expect(second.parts.map((part: { text?: string }) => part.text)).toContain('A different message');
    expect(sendAdmission.unconfirmed(c.runtimeA, session.id)).toBeUndefined();
  } finally { sendUnconfirmed.ms = was; info.mockRestore(); warning.mockRestore(); await c.dispose(); }
}, 30_000);

// Re-audit of 2f0c8e95, P2s: a marker that outlives the session turning stock still offers the explicit escape, and the
// confirm does nothing once the composer shows another session.
test('a stale marker on a now-stock session offers the discard, and the confirm is inert after switching away', async () => {
  const actions: Array<{ label: string; onClick: () => void }> = [];
  const record = (_message: React.ReactNode, data?: ExternalToast) => {
    const parsed = actionSchema.safeParse(data?.action);
    if (parsed.success) actions.push({ label: parsed.data.label, onClick: () => parsed.data.onClick() });
    return 'test-toast';
  };
  const info = spyOn(toast, 'info').mockImplementation(record);
  const warning = spyOn(toast, 'warning').mockImplementation(record);
  const other = { ...session, id: '01234567-1234-4234-9234-0123456789ff', title: 'other' };
  const stock = { ...session, nativeCreation: undefined };
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [stock, other] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  let posts = 0;
  c.handlers.prompt = async () => { posts++; return new Response(null, { status: 204 }); };
  c.handlers.history = async () => Response.json([]);
  try {
    // An earlier ordinary Send left an unresolved marker; the session is stock now.
    const stale = sendAdmission.begin(c.runtimeA, session.id, 'msg_stale', 'old');
    expect(await stale!.acquire()).toBe('acquired');
    stale!.dispatched(); stale!.failed('unknown');
    await c.replace('A stock message'); await c.submit(); await act(async () => { await sleep(50); });
    expect(posts).toBe(0);
    expect(actions.map(action => action.label)).toEqual(['Discard and send anyway']);
    await act(async () => { actions[0].onClick(); await sleep(20); });
    // Switch to another session before confirming: the confirm must not clear this marker or send anything.
    await act(async () => { useSessionUIStore.setState({ currentSessionId: other.id }); });
    await act(async () => { c.rerender(); await sleep(20); });
    await act(async () => { actions[1].onClick(); await sleep(50); });
    expect(posts).toBe(0);
    expect(sendAdmission.unconfirmed(c.runtimeA, session.id)?.messageID).toBe('msg_stale');
  } finally { info.mockRestore(); warning.mockRestore(); await c.dispose(); }
}, 30_000);

// openchamber#566 code review P1 (b): the retry identity covers inline-comment (and linked) context. Same text, but a
// changed inline comment, is a different message: it waits for the outcome instead of reusing the first client ID.
test('only the inline-comment context changes: the re-send is not treated as the same message', async () => {
  const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
  const addInline = (text: string) => useInlineCommentDraftStore.getState().addDraft({ directory: A, sessionKey: session.id }, {
    source: 'file', fileLabel: 'context.ts', startLine: 1, endLine: 1, code: text, language: 'ts', text });
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => { posts++; return new Response(null, { status: 503 }); };
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await act(async () => { addInline('first comment'); });
    await c.replace('Same text'); await c.submit();
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id)?.inFlight === false);
    await until(() => c.text() === 'Same text');
    // The given-back comment is replaced by another one; the text is unchanged.
    await act(async () => {
      const store = useInlineCommentDraftStore.getState();
      for (const draft of store.getDrafts({ directory: A, sessionKey: session.id })) store.removeDraft({ directory: A, sessionKey: session.id }, draft.id);
      addInline('a different comment');
    });
    await c.submit(); await act(async () => { await sleep(100); });
    expect(posts).toBe(1);
  } finally { sendUnconfirmed.ms = was; await c.dispose(); }
}, 30_000);

// openchamber#566 review delta P1: an inline comment edited in place (same draft ID and text, another file and line range)
// is a different outgoing message too.
test('only an inline comment location changes: the re-send is not treated as the same message', async () => {
  const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
  const target = { directory: A, sessionKey: session.id };
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => { posts++; return new Response(null, { status: 503 }); };
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await act(async () => { useInlineCommentDraftStore.getState().addDraft(target, {
      source: 'file', fileLabel: 'a.ts', startLine: 1, endLine: 2, code: 'x', language: 'ts', text: 'note' }); });
    await c.replace('Same text'); await c.submit();
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id)?.inFlight === false);
    await until(() => c.text() === 'Same text');
    // Moved in place: the same draft, now on another file and range.
    await act(async () => {
      const store = useInlineCommentDraftStore.getState();
      const [draft] = store.getDrafts(target);
      store.updateDraft(target, draft.id, { fileLabel: 'b.ts', startLine: 10, endLine: 12 });
    });
    expect(useInlineCommentDraftStore.getState().getDrafts(target).map(draft => draft.fileLabel)).toEqual(['b.ts']);
    await c.submit(); await act(async () => { await sleep(100); });
    expect(posts).toBe(1);
  } finally { sendUnconfirmed.ms = was; await c.dispose(); }
}, 30_000);
