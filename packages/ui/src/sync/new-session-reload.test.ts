import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from '@/components/chat/composer/submit/__tests__/nativeComposer-dom';

// Bind real Web Storage before product singletons can choose their memory-only fallback.
const dom = nativeComposerDom();
afterAll(async () => { await dom.restore(); });
const { directory, nativeDraftFixture, session } = await import('./native-draft-fixture');
const { markDraftInputEdited, restoreManagedSessionSelection, useSessionUIStore } = await import('./session-ui-store');
const { persistLastActiveSession, readLastActiveSession } = await import('./last-session-cache');
const { createChatDraftIdentity, readChatDraft, writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { newSessionSlotKey } = await import('@/lib/chatDraftTabs');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { getDeferredSafeStorage, getSafeSessionStorage } = await import('@/stores/utils/safeStorage');

// Tab B holds an unsent New session draft; tab A sends a first message, which moves the shared
// `oc.lastSession.v1` pointer to A's new session. B's reload must keep B's own New session view and draft.
// Real stores and storage; no module mocks. Tab A is the same store's real "submitted-draft" transition, run while the
// tab-local pointer key (sessionStorage) holds A's value, so B's own value is set aside and put back afterwards.

let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });
const flush = () => sleep(0); // Deferred localStorage writes land on a zero timer.
const rows = [{ id: 'gateway-a', worktree: directory }];
const typed = 'Tab B unsent draft T';
const tabKey = (runtimeKey: string) => `oc.lastSession.tab.v1:${runtimeKey}`;

/** Runs `step` as another tab: this tab's own last-session key is hidden during it and restored after. */
async function asOtherTab(runtimeKey: string, step: () => void | Promise<void>): Promise<void> {
  const tabSession = getSafeSessionStorage(), key = tabKey(runtimeKey);
  const own = tabSession.getItem(key);
  tabSession.removeItem(key);
  try { await step(); await flush(); }
  finally {
    if (own === null) tabSession.removeItem(key);
    else tabSession.setItem(key, own);
  }
}

/** Tab B: an explicit New session with typed, unsent input saved in B's own draft slot. */
async function draftInTabB(runtimeKey: string) {
  useSessionUIStore.getState().openNewSessionDraft();
  const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
  const identity = createChatDraftIdentity(runtimeKey, directory, null);
  writeChatDraft(identity, typed, []);
  markDraftInputEdited(draftId);
  await flush();
  return identity;
}

/** Tab A's first send materializes its draft session through the real store transition. */
const sendInTabA = (runtimeKey: string) => asOtherTab(runtimeKey, () => {
  useSessionUIStore.getState().setCurrentSession(session.id, directory, 'submitted-draft');
});

/** B's cold reload: UI/catalog memory is gone; sessionStorage, localStorage, and B's draft slot survive. */
async function coldReloadB() {
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  try {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [{ id: 'stale', path: '/stale-project' }], activeProjectId: 'stale' });
    useDirectoryStore.setState({ currentDirectory: '/stale-project' });
    opencodeClient.setDirectory('/stale-project');
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
    getDeferredSafeStorage().removeItem('oc.chatInput.lastDraftTarget');
    useSessionUIStore.getState().openNewSessionDraft({ automatic: true }); // ChatContainer's boot fallback.
    await flush();
    useProjectsStore.getState().admitManagedCatalog();
    await flush();
    useProjectsStore.getState().applyManagedCatalog(rows);
    useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
    await flush();
  } finally { home.mockRestore(); }
}

test('B keeps its New session and draft T after A sends and moves the shared pointer', async () => {
  const f = fixture = nativeDraftFixture();
  const identity = await draftInTabB(f.runtimeA);
  expect(readLastActiveSession(f.runtimeA, getDeferredSafeStorage())).toBeNull();
  const ownBefore = getSafeSessionStorage().getItem(tabKey(f.runtimeA));
  expect(dom.window.localStorage.getItem(newSessionSlotKey(f.runtimeA, directory))).toContain(typed);
  await sendInTabA(f.runtimeA);
  // The shared pointer moved across tabs; B's own tab key is what it was.
  expect(readLastActiveSession(f.runtimeA, getDeferredSafeStorage())?.sessionId).toBe(session.id);
  expect(getSafeSessionStorage().getItem(tabKey(f.runtimeA))).toBe(ownBefore);
  expect(dom.window.localStorage.getItem('oc.lastSession.v1')).toContain(session.id);
  await coldReloadB();
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
  expect(readChatDraft(identity).text).toBe(typed);
});

test('B still opens a session by explicit route after its draft survived', async () => {
  const f = fixture = nativeDraftFixture();
  const identity = await draftInTabB(f.runtimeA);
  await sendInTabA(f.runtimeA);
  await coldReloadB();
  // The route's managed step: record the chosen session, then restore it as the person's choice.
  persistLastActiveSession(f.runtimeA, { sessionId: session.id, directory });
  restoreManagedSessionSelection(useGlobalSessionsStore.getState().activeSessions, { chosen: true });
  await flush();
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  expect(readChatDraft(identity).text).toBe(typed);
});

test('control: B reloads its own existing session', async () => {
  fixture = nativeDraftFixture();
  useSessionUIStore.getState().setCurrentSession(session.id, directory);
  await flush();
  await coldReloadB();
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
});

test('control: a fresh tab with no tab pointer falls back to the shared pointer', async () => {
  const f = fixture = nativeDraftFixture();
  await sendInTabA(f.runtimeA);
  getSafeSessionStorage().removeItem(tabKey(f.runtimeA)); // A fresh tab: nothing of its own.
  await coldReloadB();
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});

test('control: no pointer anywhere keeps the automatic New session', async () => {
  const f = fixture = nativeDraftFixture();
  getSafeSessionStorage().removeItem(tabKey(f.runtimeA));
  expect(readLastActiveSession(f.runtimeA, getDeferredSafeStorage())).toBeNull();
  await coldReloadB();
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
});
