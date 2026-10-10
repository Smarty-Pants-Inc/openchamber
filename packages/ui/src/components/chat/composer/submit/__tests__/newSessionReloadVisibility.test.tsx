import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getDeferredSafeStorage, getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { createChatDraftIdentity, readChatDraft } from '@/lib/chatDraftPersistence';
import { opencodeClient } from '@/lib/opencode/client';

// After the fixture: its leaf mocks are registered before ChatInput loads.
const { ChatInput } = await import('@/components/chat/ChatInput');

// Mounted: B's actual ChatInput still shows its unsent text T after tab A's first send moved the shared
// last-session pointer and B reloaded. The shared fixture stubs unrelated leaf panels/hooks with module mocks (see
// nativeComposer.fixture.tsx); this file adds none. Tab A is the real "submitted-draft" store transition, run while B's
// tab-local pointer key is set aside. B's ChatInput is not rendered meanwhile: in a real browser A's store is A's own,
// while here one store serves both, so a mounted B composer would wrongly react to A's send.

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; showB = true; });
const settle = () => sleep(0);
const rows = [{ id: 'gateway-a', worktree: directory }];
const typed = 'Tab B unsent draft T';
let showB = true;
const tabB = () => showB ? <ChatInput /> : null;
const tabKey = (runtimeKey: string) => `oc.lastSession.tab.v1:${runtimeKey}`;

async function asOtherTab(c: NonNullable<typeof mounted>, runtimeKey: string, step: () => void) {
  await act(async () => { showB = false; c.rerender(); await settle(); });
  const tabSession = getSafeSessionStorage(), key = tabKey(runtimeKey), own = tabSession.getItem(key);
  tabSession.removeItem(key);
  try { await act(async () => { step(); await settle(); }); }
  finally { if (own === null) tabSession.removeItem(key); else tabSession.setItem(key, own); }
}

async function coldReload(c: NonNullable<typeof mounted>) {
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  try {
    await act(async () => {
      useProjectsStore.getState().resetManagedCatalog();
      useProjectsStore.setState({ projects: [{ id: 'stale', path: '/stale-project' }], activeProjectId: 'stale' });
      useDirectoryStore.setState({ currentDirectory: '/stale-project' });
      opencodeClient.setDirectory('/stale-project');
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      getDeferredSafeStorage().removeItem('oc.chatInput.lastDraftTarget');
      useSessionUIStore.getState().openNewSessionDraft({ automatic: true });
      await settle();
    });
    await act(async () => { showB = true; c.remount(); await settle(); });
    await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await settle(); });
    await act(async () => {
      useProjectsStore.getState().applyManagedCatalog(rows);
      useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
      await settle();
    });
  } finally { home.mockRestore(); }
}

test('B shows its New session composer with T after A sends and B reloads', async () => {
  const c = mounted = await mountedNativeComposer(true, undefined, undefined, tabB);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true); // The fixture's open New session in B.
  await c.replace(typed); // The actual composer marks the draft input edited.
  // The person switches to tab A: B goes hidden, and its composer saves B's own draft slot.
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const identity = createChatDraftIdentity(c.runtimeA, directory, null);
  expect(readChatDraft(identity).text).toBe(typed);
  await asOtherTab(c, c.runtimeA, () => useSessionUIStore.getState().setCurrentSession(session.id, directory, 'submitted-draft'));
  expect(readLastActiveSession(c.runtimeA, getDeferredSafeStorage())?.sessionId).toBe(session.id);
  await coldReload(c);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
  expect(c.text()).toBe(typed);
  expect(readChatDraft(identity).text).toBe(typed);
  expect(c.prompts()).toHaveLength(0);
});

test('control: B reloads its own existing session in the mounted composer', async () => {
  const c = mounted = await mountedNativeComposer(true, undefined, undefined, tabB);
  await act(async () => { useSessionUIStore.getState().setCurrentSession(session.id, directory); await settle(); });
  await coldReload(c);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
});
