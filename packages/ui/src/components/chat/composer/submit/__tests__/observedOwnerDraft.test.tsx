import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { deferred, directory as A, session } from '@/sync/native-draft-fixture';
import { adoptObservedSessionOwner } from '@/sync/session-actions';
import { checkSelectedSessionOwner } from '@/sync/selected-session-owner';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from '@/sync/input-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { createChatDraftIdentity, readChatDraft, readChatDraftSince, writeChatDraft } from '@/lib/chatDraftPersistence';

const B = '/native-project-b';
const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const row = (directory: string, ended = false) => ({ ...session, directory, ordinary, nativeRuntime: 'ordinary',
  herdrState: ended ? 'ended' : 'idle', herdrPaneLive: !ended });
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreDetail = () => {};
afterEach(async () => { restoreDetail(); restoreDetail = () => {}; await mounted?.dispose(); mounted = undefined; });

async function mount(persist = true, detailResponse: () => Promise<Response> = async () => Response.json(row(B))) {
  const c = mounted = await mountedNativeComposer(persist, undefined, undefined, undefined, f => {
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
      managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }],
      managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }, { id: 'b', path: B, addedAt: 0, lastOpenedAt: 0 }] });
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)] });
    useGlobalSessionsStore.getState().applySnapshot([], []);
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A,
      selectedManagedOwner: null, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === 'synthetic.invalid' && request.method === 'GET' && url.pathname.endsWith(`/session/${session.id}`)) {
      c.requests.push(request); return detailResponse();
    }
    return previousFetch(input, init);
  };
  restoreDetail = () => { globalThis.fetch = previousFetch; };
  const identity = (directory: string, sessionId = session.id, runtimeKey = c.runtimeA) => createChatDraftIdentity(runtimeKey, directory, sessionId)!;
  await c.replace('Unsent investigation'); await c.mention('confirmed.md');
  expect(c.text()).toContain('@confirmed.md');
  expect(c.dom.container.querySelectorAll('.cm-content')).toHaveLength(1);
  return { ...c, identity };
}

for (const persist of [true, false]) test(`actual composer retains live input and confirmed mention through verified A-to-B adoption, persistence ${persist}`, async () => {
  const c = await mount(persist), text = c.text(), editor = c.editor();
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  const since = readChatDraftSince(c.identity(A));
  if (persist) expect(readChatDraft(c.identity(A)).confirmedMentions.has('confirmed.md')).toBe(true);
  await act(async () => { await checkSelectedSessionOwner(session.id, A); });
  expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('live');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
  expect(useSessionUIStore.getState().getDirectoryForSession(session.id)).toBe(B);
  expect(c.text()).toBe(text); expect(c.editor()).toBe(editor);
  if (persist) {
    expect(readChatDraft(c.identity(B)).text).toBe(text);
    expect(readChatDraft(c.identity(B)).confirmedMentions.has('confirmed.md')).toBe(true);
    expect(readChatDraftSince(c.identity(B))).toBe(since);
    await act(async () => c.remount());
    expect(c.text()).toBe(text);
    expect(readChatDraft(c.identity(B)).confirmedMentions.has('confirmed.md')).toBe(true);
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(readChatDraft(c.identity(B)).text).toBe(text);
  } else {
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(readChatDraft(c.identity(B)).text).toBe('');
  }
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});

test('unflushed live text and confirmed mention move to the reopened destination before the debounce', async () => {
  const c = await mount(), text = c.text();
  expect(readChatDraft(c.identity(A)).text).toBe('');
  await act(async () => { await checkSelectedSessionOwner(session.id, A); });
  expect(c.text()).toBe(text);
  expect(readChatDraft(c.identity(B)).text).toBe(text);
  expect(readChatDraft(c.identity(B)).confirmedMentions.has('confirmed.md')).toBe(true);
  const since = readChatDraftSince(c.identity(B));
  await act(async () => c.remount());
  expect(c.text()).toBe(text);
  expect(readChatDraftSince(c.identity(B))).toBe(since);
  expect(readChatDraft(c.identity(B)).confirmedMentions.has('confirmed.md')).toBe(true);
});

test('destination conflict refuses before owner, history and either draft can change', async () => {
  const c = await mount(), text = c.text();
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  writeChatDraft(c.identity(B), 'Other destination input @destination.md', ['destination.md']);
  const target = { directory: A, sessionID: session.id };
  await c.loader.ensure(target, { reason: 'navigation' });
  const source = c.children.getChild(A)!.getState();
  const accepted = c.loader.getAcceptedOrdinaryView(target, c.runtimeA);
  await act(async () => { await checkSelectedSessionOwner(session.id, A); });
  expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('unknown');
  const refusal = useSessionUIStore.getState().selectedManagedOwner;
  expect(refusal?.status === 'unknown' && refusal.reason).toContain('destination draft is not empty');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(c.children.getChild(A)!.getState()).toBe(source);
  expect(c.loader.getAcceptedOrdinaryView(target, c.runtimeA)).toBe(accepted);
  expect(c.text()).toBe(text);
  expect(readChatDraft(c.identity(A)).confirmedMentions.has('confirmed.md')).toBe(true);
  expect(readChatDraft(c.identity(B))).toEqual({ text: 'Other destination input @destination.md', confirmedMentions: new Set(['destination.md']) });
  await act(async () => c.remount()); expect(c.text()).toBe(text);
});

for (const exit of ['saved', 'id', 'runtime', 'unmount'] as const) test(`one concurrent destination write protects both inputs through ${exit}`, async () => {
  const persist = exit === 'saved', c = await mount(persist);
  await c.mention('NOTES'); const text = c.text(), editor = c.editor();
  const destination = c.children.ensureChild(B, { bootstrap: false });
  let writes = 0, bytes: string | null = null;
  const stop = destination.subscribe(state => {
    if (!writes && state.session.some(row => row.id === session.id)) {
      writes++; writeChatDraft(c.identity(B), 'Concurrent destination @destination.md', ['destination.md']);
      bytes = getSafeStorage().getItem('openchamber.chatDrafts.v2');
    }
  });
  try { await act(async () => { await checkSelectedSessionOwner(session.id, A); }); } finally { stop(); }
  expect(writes).toBe(1); expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('live');
  expect(useSessionUIStore.getState().getDirectoryForSession(session.id)).toBe(B); expect(c.editor()).toBe(editor);
  expect(c.text()).toBe(persist ? 'Concurrent destination @destination.md' : text);
  if (persist) {
    expect(readChatDraft(c.identity(A))).toEqual({ text, confirmedMentions: new Set(['confirmed.md', 'NOTES']) });
    await act(async () => c.remount()); expect(c.text()).toBe('Concurrent destination @destination.md');
  } else {
    expect(readChatDraft(c.identity(A)).text).toBe('');
    expect([...c.editor().dom.querySelectorAll('span')].some(node => node.textContent === '@NOTES' && node.className.includes('--status-info'))).toBe(true);
    expect(c.dom.container.querySelector('[role="alert"]')?.textContent).toContain('Copy');
    await act(async () => { window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('freeze')); });
    await act(async () => useUIStore.setState({ persistChatDraft: true }));
    await c.replace(`${text} edited`); await act(async () => { await sleep(550); window.dispatchEvent(new Event('pagehide')); });
    expect(c.text()).toBe(`${text} edited`); expect(readChatDraft(c.identity(A)).text).toBe('');
    expect([...c.editor().dom.querySelectorAll('span')].some(node => node.textContent === '@NOTES' && node.className.includes('--status-info'))).toBe(true);
    await act(async () => useUIStore.setState({ persistChatDraft: false }));
    expect(getSafeStorage().getItem('openchamber.chatDrafts.v2')).toBe(bytes);
    await act(async () => useUIStore.setState({ persistChatDraft: true }));
    if (exit === 'id') {
      await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated', currentSessionDirectory: B }));
      expect(c.text()).toBe('');
    } else if (exit === 'runtime') {
      await act(async () => { c.switchRuntime(`${c.runtimeA}-other`); c.rerender(); }); expect(c.text()).toBe('');
    } else { await act(async () => c.remount()); expect(c.text()).toBe('Concurrent destination @destination.md'); }
    expect(getSafeStorage().getItem('openchamber.chatDrafts.v2')).toBe(bytes);
  }
  expect(readChatDraft(c.identity(B))).toEqual({ text: 'Concurrent destination @destination.md', confirmedMentions: new Set(['destination.md']) });
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});

test('background adoption and ordinary same-ID directory navigation do not carry selected input', async () => {
  const c = await mount(), text = c.text();
  const background = { ...row(B), id: 'other-native-session' };
  await act(async () => adoptObservedSessionOwner(background, A));
  expect(c.text()).toBe(text); expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  await act(async () => {
    c.children.getChild(A)!.setState({ session: [row(B)] });
    useSessionUIStore.getState().setSessionDirectory(session.id, B);
  });
  expect(c.text()).toBe('');
  expect(readChatDraft(c.identity(A)).text).toBe(text);
  expect(readChatDraft(c.identity(A)).confirmedMentions.has('confirmed.md')).toBe(true);
  expect(readChatDraft(c.identity(B)).text).toBe('');
});

test('held verification from a retired runtime cannot adopt or carry its input to equal IDs', async () => {
  const response = deferred<Response>();
  const c = await mount(true, () => response.promise), text = c.text();
  let check = Promise.resolve();
  act(() => { check = checkSelectedSessionOwner(session.id, A); });
  expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('checking');
  await act(async () => {
    c.switchRuntime(`${c.runtimeA}-retired`);
    useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: A, selectedManagedOwner: null });
    c.rerender();
    response.resolve(Response.json(row(B))); await check;
  });
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(c.text()).toBe('');
  expect(readChatDraft(c.identity(A)).text).toBe(text);
  expect(readChatDraft(c.identity(A)).confirmedMentions.has('confirmed.md')).toBe(true);
  expect(readChatDraft(c.identity(B, session.id, `${c.runtimeA}-retired`)).text).toBe('');
});

test('runtime change does not carry text or confirmed mentions to an equal session ID', async () => {
  const c = await mount(), text = c.text();
  await act(async () => {
    c.switchRuntime(`${c.runtimeA}-other`);
    useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: A });
    c.rerender();
  });
  expect(c.text()).toBe('');
  expect(readChatDraft(c.identity(A)).text).toBe(text);
  expect(readChatDraft(c.identity(A)).confirmedMentions.has('confirmed.md')).toBe(true);
  expect(readChatDraft(c.identity(A, session.id, `${c.runtimeA}-other`)).confirmedMentions.size).toBe(0);
});
