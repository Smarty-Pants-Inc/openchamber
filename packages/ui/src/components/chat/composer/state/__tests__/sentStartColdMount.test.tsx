import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';

// #117 (Astra pre-check 4): a composer mounted cold (a load or New session) with an admitted sent mark must consume the
// delivered text from its live editor too, not only from storage: the composer's draft consumer listens by then.
const dom = nativeComposerDom();
afterAll(async () => { await dom.restore(); });
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('../useComposerDraft');
const { resetSentStartsForPage, useSentStart } = await import('@/sync/native-draft-sent');

test('a cold-mounted composer consumes text another tab already delivered, and stays editable for new text', async () => {
  const runtimeKey = 'sent-cold-mount', directory = '/synthetic', draftId = 3, delivered = 'already delivered text';
  const identity = { runtimeKey, directory, sessionId: null, draftId };
  localStorage.setItem(`oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`,
    JSON.stringify({ clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', admitted: true, text: delivered, at: Date.now() }));
  const messageRef = { current: delivered }, confirmedMentionsRef = { current: new Set<string>() };
  let shown = '', outcome: string | null = 'unset';
  function Composer() {
    const [message, setMessage] = React.useState(delivered);
    const change = (text: string) => { messageRef.current = text; setMessage(text); };
    // The same order as ChatInput: the sent-start hook before the draft hook.
    outcome = useSentStart(runtimeKey, directory, draftId, () => undefined);
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef, identity, persistEnabled: true,
      initialDraft: { text: delivered, identity } });
    shown = message;
    return null;
  }
  const root = createRoot(dom.container);
  try {
    await act(async () => { root.render(<Composer />); });
    await act(async () => { await new Promise(done => setTimeout(done, 10)); });
    expect(shown).toBe('');
    expect(outcome).toBeNull(); // Delivered: not locked.
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

// Astra pre-check (#220 round 5): two admissions queued while this tab was suspended (A, then the project's next Send B)
// each consume their own text: the later mark never hides A's delivered text.
test('queued admissions A then B: the open composer consumes A, never offers it to send again', async () => {
  const runtimeKey = 'sent-queued', directory = '/synthetic', draftId = 4, delivered = 'message A';
  const identity = { runtimeKey, directory, sessionId: null, draftId };
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  const messageRef = { current: delivered }, confirmedMentionsRef = { current: new Set<string>() };
  let shown = '', outcome: string | null = 'unset';
  function Composer() {
    const [message, setMessage] = React.useState(delivered);
    const change = (text: string) => { messageRef.current = text; setMessage(text); };
    outcome = useSentStart(runtimeKey, directory, draftId, () => undefined);
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef, identity, persistEnabled: true,
      initialDraft: { text: delivered, identity } });
    shown = message;
    return null;
  }
  const root = createRoot(dom.container);
  try {
    await act(async () => { root.render(<Composer />); });
    await act(async () => { await new Promise(done => setTimeout(done, 10)); });
    expect(shown).toBe(delivered); // No mark yet: an ordinary draft.
    // Fresh request ids: the page's handled set outlives the test above.
    const a = JSON.stringify({ clientRequestId: '11111111-1111-4111-8111-111111111111', admitted: true, text: delivered, at: Date.now() });
    const b = JSON.stringify({ clientRequestId: '22222222-2222-4222-8222-222222222222', admitted: true, text: 'message B', at: Date.now() });
    localStorage.setItem(key, b); // By the time this tab runs, the slot already holds B.
    // The DOM window's own event constructor (no global StorageEvent here).
    const Storage = (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent;
    await act(async () => {
      window.dispatchEvent(new Storage('storage', { key, oldValue: null, newValue: a }));
      window.dispatchEvent(new Storage('storage', { key, oldValue: a, newValue: b }));
      await new Promise(done => setTimeout(done, 10));
    });
    expect(shown).toBe('');
    expect(outcome).toBeNull();
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

// Review of #220 (fbcc3093): each editor judges its own copy by when its text began. Tab B's copy (saved before the
// admission) is consumed even though tab A has since saved a newer draft in the shared slot, which survives; a draft
// restored after a reload that began after the admission is a new message and survives too.
const draftsKey = 'openchamber.chatDrafts.v2';
const saveSlot = (runtimeKey: string, directory: string, text: string, since: number) => localStorage.setItem(draftsKey,
  JSON.stringify({ version: 2, drafts: { [JSON.stringify([runtimeKey, directory, null])]: { text, confirmedMentions: [], touchedAt: since, since } } }));
const savedText = (runtimeKey: string, directory: string) =>
  (JSON.parse(localStorage.getItem(draftsKey) ?? '{"drafts":{}}').drafts[JSON.stringify([runtimeKey, directory, null])]?.text ?? '') as string;
async function mountComposer(runtimeKey: string, directory: string, draftId: number, text: string) {
  const identity = { runtimeKey, directory, sessionId: null, draftId };
  const messageRef = { current: text }, confirmedMentionsRef = { current: new Set<string>() };
  const seen: { shown: string; type: (next: string) => void } = { shown: '', type: () => {} };
  function Composer() {
    const [message, setMessage] = React.useState(text);
    const change = (next: string) => { messageRef.current = next; setMessage(next); };
    seen.type = change;
    useSentStart(runtimeKey, directory, draftId, () => undefined);
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef, identity, persistEnabled: true,
      initialDraft: { text, identity } });
    seen.shown = message;
    return null;
  }
  const root = createRoot(dom.container);
  await act(async () => { root.render(<Composer />); });
  await act(async () => { await new Promise(done => setTimeout(done, 10)); });
  return { seen, root };
}
const admittedEvent = async (key: string, value: string) => {
  const Storage = (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent;
  await act(async () => { window.dispatchEvent(new Storage('storage', { key, oldValue: null, newValue: value })); await new Promise(done => setTimeout(done, 10)); });
};

test("tab B's old copy is consumed while tab A's newer saved draft in the shared slot survives", async () => {
  const runtimeKey = 'sent-newer-slot', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'hello', now - 60_000); // B restored and saved "hello" before the admission.
  const { seen, root } = await mountComposer(runtimeKey, directory, 5, 'hello');
  try {
    const mark = JSON.stringify({ clientRequestId: '33333333-3333-4333-8333-333333333333', admitted: true, text: 'hello', at: now - 30_000 });
    const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
    localStorage.setItem(key, mark);
    saveSlot(runtimeKey, directory, 'A new draft', now - 1_000); // A consumed its copy, then saved a new draft.
    await admittedEvent(key, mark); // B resumes and handles the queued admission.
    expect(seen.shown).toBe('');
    expect(savedText(runtimeKey, directory)).toBe('A new draft');
    // Nor later: past the save debounce, a page hide, and unmount.
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    expect(savedText(runtimeKey, directory)).toBe('A new draft');
    await act(async () => { window.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('pagehide')); });
    expect(savedText(runtimeKey, directory)).toBe('A new draft');
    act(() => root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('A new draft');
  } finally { try { act(() => root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test('after a reload, a restored draft that began after the admission is kept, in the editor and saved', async () => {
  const runtimeKey = 'sent-after-reload', directory = '/synthetic', now = Date.now();
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  localStorage.setItem(key, JSON.stringify({ clientRequestId: '44444444-4444-4444-8444-444444444444', admitted: true, text: 'hello', at: now - 60_000 }));
  saveSlot(runtimeKey, directory, 'hello', now - 1_000); // New session, the same words typed after the admission.
  const { seen, root } = await mountComposer(runtimeKey, directory, 6, 'hello');
  try {
    expect(seen.shown).toBe('hello');
    expect(savedText(runtimeKey, directory)).toBe('hello');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

test("tab A's different unsent draft, saved before the admission, survives B consuming its delivered copy", async () => {
  const runtimeKey = 'sent-other-text', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'hello', now - 60_000);
  const { seen, root } = await mountComposer(runtimeKey, directory, 7, 'hello');
  try {
    saveSlot(runtimeKey, directory, 'A replacement unsent draft', now - 45_000); // A saved another text, then left.
    const mark = JSON.stringify({ clientRequestId: '55555555-5555-4555-8555-555555555555', admitted: true, text: 'hello', at: now - 30_000 });
    const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
    localStorage.setItem(key, mark);
    await admittedEvent(key, mark);
    expect(seen.shown).toBe('');
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    act(() => root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('A replacement unsent draft');
  } finally { try { act(() => root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test('after B consumes its copy, B types the same words anew: saved with B\'s own start, they survive a reload', async () => {
  const runtimeKey = 'sent-retyped', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'hello', now - 60_000);
  const first = await mountComposer(runtimeKey, directory, 8, 'hello');
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  try {
    saveSlot(runtimeKey, directory, 'A replacement unsent draft', now - 45_000);
    const mark = JSON.stringify({ clientRequestId: '66666666-6666-4666-8666-666666666666', admitted: true, text: 'hello', at: now - 30_000 });
    localStorage.setItem(key, mark);
    await admittedEvent(key, mark);
    expect(first.seen.shown).toBe('');
    await act(async () => { first.seen.type('hello'); }); // A new message with the same words.
    await act(async () => { await new Promise(done => setTimeout(done, 700)); }); // The save debounce.
    expect(savedText(runtimeKey, directory)).toBe('hello');
    act(() => first.root.unmount());
    resetSentStartsForPage(); // The reload.
    const second = await mountComposer(runtimeKey, directory, 9, 'hello');
    try {
      expect(second.seen.shown).toBe('hello');
      expect(savedText(runtimeKey, directory)).toBe('hello');
    } finally { act(() => second.root.unmount()); }
  } finally { try { act(() => first.root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test("an empty peer editor handling another tab's admission never deletes that tab's saved unsent draft", async () => {
  const runtimeKey = 'sent-empty-peer', directory = '/synthetic', now = Date.now();
  const { seen, root } = await mountComposer(runtimeKey, directory, 10, '');
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  try {
    await act(async () => { await new Promise(done => setTimeout(done, 700)); }); // B's debounce settles (empty).
    const mark = JSON.stringify({ clientRequestId: '77777777-7777-4777-8777-777777777777', admitted: true, text: 'hello', at: now - 30_000 });
    localStorage.setItem(key, mark);
    saveSlot(runtimeKey, directory, 'A new unsent draft', now - 1_000); // A sent "hello", saved a new draft, closed.
    await admittedEvent(key, mark); // B resumes.
    expect(seen.shown).toBe('');
    expect(savedText(runtimeKey, directory)).toBe('A new unsent draft');
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    expect(savedText(runtimeKey, directory)).toBe('A new unsent draft');
    act(() => root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('A new unsent draft');
  } finally { try { act(() => root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test('history-confirmed delivery consumes this copy but keeps another tab\'s replacement saved while the read was held', async () => {
  const { opencodeClient } = await import('@/lib/opencode/client');
  const runtimeKey = 'sent-history', directory = '/synthetic', id = '88888888-8888-4888-8888-888888888888';
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  saveSlot(runtimeKey, directory, 'hello', Date.now() - 60_000);
  localStorage.setItem(key, JSON.stringify({ clientRequestId: id })); // Another tab's accepted start; its outcome unknown here.
  let answer = () => {};
  const held = new Promise<void>(done => { answer = done; });
  const listed = spyOn(opencodeClient, 'listNativeCreations').mockResolvedValue([{ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    directory, generation: null, revision: 1, phase: 'ready', expiresAt: Date.now() + 60_000, canInitialReady: false, clientRequestId: id,
    native: { id: 'ses_history', generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }] as never);
  const history = spyOn(opencodeClient, 'getSessionMessages').mockImplementation((async () => {
    await held;
    return [{ info: { id: 'msg_1', sessionID: 'ses_history', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_1', type: 'text', text: 'hello' }] }];
  }) as never);
  const { seen, root } = await mountComposer(runtimeKey, directory, 11, 'hello');
  try {
    saveSlot(runtimeKey, directory, 'A replacement unsent draft', Date.now() + 1_000); // Saved while the history read was held.
    await act(async () => { answer(); await new Promise(done => setTimeout(done, 10)); });
    expect(seen.shown).toBe(''); // This tab's delivered copy is consumed...
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    act(() => root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('A replacement unsent draft'); // ...and the replacement survives.
  } finally { listed.mockRestore(); history.mockRestore(); try { act(() => root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test('B keeps its different draft through an admission, then replaces it with the delivered words: they survive a reload', async () => {
  const runtimeKey = 'sent-replaced', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'bye', now - 60_000); // B's different draft, from before the admission.
  const first = await mountComposer(runtimeKey, directory, 12, 'bye');
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  try {
    const mark = JSON.stringify({ clientRequestId: '99999999-9999-4999-8999-999999999999', admitted: true, text: 'hello', at: now - 30_000 });
    localStorage.setItem(key, mark);
    await admittedEvent(key, mark);
    expect(first.seen.shown).toBe('bye');
    await act(async () => { first.seen.type('hello'); }); // Select all, type the same words as a new message.
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    act(() => first.root.unmount());
    resetSentStartsForPage(); // The reload.
    const second = await mountComposer(runtimeKey, directory, 13, 'hello');
    try {
      expect(second.seen.shown).toBe('hello');
      expect(savedText(runtimeKey, directory)).toBe('hello');
    } finally { act(() => second.root.unmount()); }
  } finally { try { act(() => first.root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test('an editor that changes its saved words away and back before a delayed admission keeps them, saved', async () => {
  const runtimeKey = 'sent-away-and-back', directory = '/synthetic';
  const first = await mountComposer(runtimeKey, directory, 14, '');
  const key = `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
  try {
    await act(async () => { first.seen.type('hello'); });
    await act(async () => { await new Promise(done => setTimeout(done, 700)); }); // This editor saved "hello".
    await new Promise(done => setTimeout(done, 5));
    const mark = JSON.stringify({ clientRequestId: 'abababab-abab-4bab-8bab-abababababab', admitted: true, text: 'hello', at: Date.now() });
    localStorage.setItem(key, mark); // Another tab admitted its "hello"; this tab has not handled the event yet.
    await new Promise(done => setTimeout(done, 5));
    await act(async () => { first.seen.type('hello!'); }); // Within one save debounce: away...
    await act(async () => { first.seen.type('hello'); }); // ...and back to the same words, now a new text.
    await act(async () => { await new Promise(done => setTimeout(done, 700)); }); // The save debounce.
    await admittedEvent(key, mark);
    expect(first.seen.shown).toBe('hello');
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    act(() => first.root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('hello');
  } finally { try { act(() => first.root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test("the sender's own consumption, with its submission time, keeps another tab's replacement saved meanwhile", async () => {
  const { consumeChatDraft } = await import('@/lib/chatDraftPersistence');
  const runtimeKey = 'sent-sender', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'hello', now - 60_000);
  const { seen, root } = await mountComposer(runtimeKey, directory, 15, 'hello');
  try {
    const submittedAt = Date.now(); // This tab sends "hello"; its response is held.
    saveSlot(runtimeKey, directory, 'B replacement', Date.now() + 1_000); // Another tab saves a different draft.
    await act(async () => { consumeChatDraft({ runtimeKey, directory, sessionId: null, draftId: 15 }, 'hello', submittedAt); });
    expect(seen.shown).toBe(''); // The sender's own copy is consumed...
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    act(() => root.unmount());
    expect(savedText(runtimeKey, directory)).toBe('B replacement'); // ...and the other tab's draft stays.
  } finally { try { act(() => root.unmount()); } catch { /* unmounted */ } localStorage.clear(); }
});

test("a draft's transfer into its new session keeps another tab's different draft in the new-session slot", async () => {
  const runtimeKey = 'sent-transfer', directory = '/synthetic', now = Date.now();
  saveSlot(runtimeKey, directory, 'hello', now - 60_000);
  const draftIdentity = { runtimeKey, directory, sessionId: null, draftId: 16 };
  const sessionIdentity = { runtimeKey, directory, sessionId: 'ses_created' };
  const messageRef = { current: 'hello' }, confirmedMentionsRef = { current: new Set<string>() };
  function Composer({ identity, materialized }: { identity: typeof draftIdentity | typeof sessionIdentity; materialized?: string }) {
    const [message, setMessage] = React.useState('hello');
    const change = (next: string) => { messageRef.current = next; setMessage(next); };
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef, identity, persistEnabled: true,
      materializedSessionId: materialized, initialDraft: { text: 'hello', identity: draftIdentity } });
    return null;
  }
  const root = createRoot(dom.container);
  try {
    await act(async () => { root.render(<Composer identity={draftIdentity} />); });
    saveSlot(runtimeKey, directory, 'B draft', Date.now()); // Another tab saves its own new-session draft.
    await act(async () => { root.render(<Composer identity={sessionIdentity} materialized="ses_created" />); }); // The Send created the session.
    await act(async () => { await new Promise(done => setTimeout(done, 700)); });
    expect(savedText(runtimeKey, directory)).toBe('B draft');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});
