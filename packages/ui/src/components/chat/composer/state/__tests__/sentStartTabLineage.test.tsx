import '@/sync/native-test-network';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';
import type { ComposerLanguageContext } from '../../language/tokenize';

const dom = nativeComposerDom();
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { ComposerEditor } = await import('../../editor/ComposerEditor');
const { useComposerDraft } = await import('../useComposerDraft');
const tabs = await import('@/lib/chatDraftTabs');
const persistence = await import('@/lib/chatDraftPersistence');
const sent = await import('@/sync/native-draft-sent');

// B uses the real page singleton and its real per-tab slot throughout every mounted effect.
// A needs only a separate sessionStorage identity and the shared localStorage, not a mocked draft owner.
const receiverTab = tabs.tabId();
const senderSession = new Map<string, string>();
const sender = tabs.createTabDrafts({ storage: localStorage, session: {
  getItem: key => senderSession.get(key) ?? null,
  setItem: (key, value) => { senderSession.set(key, value); },
} });
const senderTab = sender.tabId();
const directory = '/synthetic';
const text = 'independently typed identical prompt';
const language: ComposerLanguageContext = { inputMode: 'normal', knownAgentNames: new Set(),
  confirmedMentions: new Set(), knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [] };
const markerKey = (runtimeKey: string) => `oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`;
const identity = (runtimeKey: string, draftId: number) => ({ runtimeKey, directory, sessionId: null, draftId });
const mounted = new Set<ReturnType<typeof createRoot>>();
type ComposerObservation = { outcome: ReturnType<typeof sent.useSentStart> };

afterEach(async () => {
  for (const root of mounted) await act(async () => root.unmount());
  mounted.clear();
  sent.resetSentStartsForPage();
  localStorage.clear();
});
afterAll(async () => { await dom.restore(); });

function saveReceiver(runtimeKey: string, since: number) {
  expect(persistence.writeChatDraft({ runtimeKey, directory, sessionId: null }, text, [], since)).toBe(true);
}

async function mountReceiver(runtimeKey: string, draftId: number) {
  const target = identity(runtimeKey, draftId);
  const initial = persistence.readChatDraft(target);
  const messageRef = { current: initial.text };
  const confirmedMentionsRef = { current: initial.confirmedMentions };
  const state: ComposerObservation = { outcome: null };
  function Composer() {
    const [message, setMessage] = React.useState(initial.text);
    const change = React.useCallback((next: string) => { messageRef.current = next; setMessage(next); }, []);
    // ChatInput uses this same order. The first sent read must wait for the draft consumer's effect.
    state.outcome = sent.useSentStart(runtimeKey, directory, draftId, () => undefined);
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef,
      identity: target, persistEnabled: true, initialDraft: { text: initial.text, identity: target } });
    return <ComposerEditor value={message} onChange={edit => change(edit.value)} languageContext={language}
      editable={!sent.sentStartLocks(state.outcome)} />;
  }
  const root = createRoot(dom.container);
  mounted.add(root);
  await act(async () => { root.render(<Composer />); });
  await act(async () => { await sleep(20); });
  const editor = () => {
    const node = dom.container.querySelector<HTMLElement>('.cm-content');
    const view = node && EditorView.findFromDOM(node);
    if (!view) throw new Error('Mounted composer editor missing');
    return view;
  };
  return { state, target, text: () => editor().state.doc.toString(),
    replace: async (value: string) => act(async () => {
      editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: value } });
    }),
    unmount: async () => { await act(async () => root.unmount()); mounted.delete(root); },
  };
}

async function admitFromSender(runtimeKey: string, request: string, at: number, sameLineage = false) {
  // A same-lineage duplicate already shares B's saved slot. An independent A writes its own slot.
  if (!sameLineage) sender.writeSlot(runtimeKey, directory, { text, confirmedMentions: [], touchedAt: at - 60_000, since: at - 60_000 });
  expect(senderTab).not.toBe(receiverTab);
  const oldValue = localStorage.getItem(markerKey(runtimeKey));
  // The exported page identity is the only spy. Slot readers/writers, consumption and both hooks stay real.
  // No mounted B effect runs while A's identity is selected. A's sent APIs are synchronous.
  await act(async () => {
    const activeTab = spyOn(tabs, 'tabId');
    activeTab.mockReturnValue(sameLineage ? receiverTab : senderTab);
    try {
      expect(sent.ensureSentStart(runtimeKey, directory, request, { text, at })).toBe('marked');
      sent.admitSentStart(runtimeKey, directory, request, text, at);
    } finally { activeTab.mockRestore(); }
    // A's page-local handled set is not B's. Reset only the sent page state before B handles the event.
    sent.resetSentStartsForPage();
  });
  const newValue = localStorage.getItem(markerKey(runtimeKey));
  expect(newValue).not.toBeNull();
  return { oldValue, newValue };
}

async function receiveAdmission(runtimeKey: string, value: { oldValue: string | null; newValue: string | null }) {
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: markerKey(runtimeKey),
      oldValue: value.oldValue ?? undefined, newValue: value.newValue ?? undefined }));
    await sleep(20);
  });
}

async function assertSavedThroughLifecycle(runtimeKey: string, composer: Awaited<ReturnType<typeof mountReceiver>>, expected: string) {
  expect(composer.text()).toBe(expected);
  expect(persistence.readChatDraft(composer.target).text).toBe(expected);
  expect(composer.state.outcome).toBeNull();
  expect(dom.container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
  await act(async () => { await sleep(550); });
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); });
  expect(persistence.readChatDraft(composer.target).text).toBe(expected);
  await composer.unmount();
  // A fresh per-tab storage owner proves the result is backing storage, not a mounted ref or slot fallback.
  const reload = tabs.createTabDrafts({ storage: localStorage, session: sessionStorage });
  expect(reload.tabId()).toBe(receiverTab);
  expect(reload.readSlot(runtimeKey, directory)?.text ?? '').toBe(expected);
}

test('#1175: B keeps its independent identical unsent text through A admission and a cold mount within ten minutes', async () => {
  const runtimeKey = 'lineage-live';
  const at = Date.now() - 30_000;
  saveReceiver(runtimeKey, at - 60_000); // B already had these words. Time/content do not establish A's lineage.
  expect(tabs.newSessionSlotKey(runtimeKey, directory)).not.toBe(sender.newSessionSlotKey(runtimeKey, directory));
  const first = await mountReceiver(runtimeKey, 101);
  expect(first.text()).toBe(text);
  const admission = await admitFromSender(runtimeKey, 'lineage-live-request', at);
  await receiveAdmission(runtimeKey, admission);
  await assertSavedThroughLifecycle(runtimeKey, first, text);
  sent.resetSentStartsForPage();
  const cold = await mountReceiver(runtimeKey, 102);
  await assertSavedThroughLifecycle(runtimeKey, cold, text);
});

test('#1175: cold B restores its independent old identical draft while A admission is still retained', async () => {
  const runtimeKey = 'lineage-cold';
  const at = Date.now() - 30_000;
  saveReceiver(runtimeKey, at - 60_000);
  await admitFromSender(runtimeKey, 'lineage-cold-request', at);
  const cold = await mountReceiver(runtimeKey, 103);
  await assertSavedThroughLifecycle(runtimeKey, cold, text);
});

test('a duplicate sharing the sender tab lineage consumes its old copy once and keeps the same words typed anew', async () => {
  const runtimeKey = 'lineage-duplicate';
  const at = Date.now() - 30_000;
  saveReceiver(runtimeKey, at - 60_000);
  const duplicate = await mountReceiver(runtimeKey, 104);
  const admission = await admitFromSender(runtimeKey, 'lineage-duplicate-request', at, true);
  await receiveAdmission(runtimeKey, admission);
  expect(duplicate.text()).toBe('');
  expect(persistence.readChatDraft(duplicate.target).text).toBe('');
  await duplicate.replace(text);
  await receiveAdmission(runtimeKey, admission); // A repeated event must not consume the new input.
  await act(async () => { await sleep(550); }); // The newly typed text becomes durable through the real debounce.
  await assertSavedThroughLifecycle(runtimeKey, duplicate, text);
  sent.resetSentStartsForPage();
  const cold = await mountReceiver(runtimeKey, 105);
  await assertSavedThroughLifecycle(runtimeKey, cold, text);
});

test('the actual sender still consumes its own accepted snapshot without consuming another tab slot', async () => {
  const runtimeKey = 'lineage-sender';
  const at = Date.now();
  saveReceiver(runtimeKey, at - 60_000);
  sender.writeSlot(runtimeKey, directory, { text, confirmedMentions: [], touchedAt: at - 60_000, since: at - 60_000 });
  const composer = await mountReceiver(runtimeKey, 106);
  await act(async () => {
    expect(sent.ensureSentStart(runtimeKey, directory, 'lineage-sender-request', { text, at })).toBe('marked');
    // This is the same persistence-owned cleanup used by the submission caller, not substitute test logic.
    expect(persistence.consumeChatDraft(composer.target, text, at)).toBe(true);
    sent.admitSentStart(runtimeKey, directory, 'lineage-sender-request', text, at);
  });
  await assertSavedThroughLifecycle(runtimeKey, composer, '');
  expect(sender.readSlot(runtimeKey, directory)?.text).toBe(text);
});

test('legacy admitted marks without tabId unlock without inventing destructive text ownership', async () => {
  const runtimeKey = 'lineage-legacy';
  const at = Date.now() - 30_000;
  saveReceiver(runtimeKey, at - 60_000);
  localStorage.setItem(markerKey(runtimeKey), JSON.stringify({ clientRequestId: 'lineage-legacy-request',
    admitted: true, text, at })); // No lineage was stored by the old writer.
  const cold = await mountReceiver(runtimeKey, 107);
  await assertSavedThroughLifecycle(runtimeKey, cold, text);
});
