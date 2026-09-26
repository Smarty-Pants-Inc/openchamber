import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { opencodeClient } from '@/lib/opencode/client';

// smarty-code#113 (code-controls, Release 3.23): a draft typed in a NEW linked-worktree project is in that project's
// slot before a reload; after the reload the slot is gone. At reload the new project may not be in the catalog yet
// (its admission is still running), so the catalog publishes first without it, then with it.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => sleep(0);
const NEW = '/native-project-a/.worktrees/new-wt';
const existing = [{ id: 'gateway-a', worktree: directory }];
const withNew = [...existing, { id: 'gateway-new', worktree: NEW }];

async function reloadInto(remembered: { projectId: string | null; directory: string | null; target: string }) {
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  try {
    await act(async () => {
      useProjectsStore.getState().resetManagedCatalog();
      useProjectsStore.setState({ projects: [{ id: 'gateway-a', path: directory }], activeProjectId: 'gateway-a' });
      useDirectoryStore.setState({ currentDirectory: directory });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      getDeferredSafeStorage().setItem('oc.chatInput.lastDraftTarget', JSON.stringify(remembered));
      useSessionUIStore.getState().openNewSessionDraft({ automatic: true });
      await settle();
    });
  } finally { home.mockRestore(); }
}

for (const lateCatalog of [true, false]) test(`a new project's draft survives a reload (${lateCatalog ? 'catalog first without it' : 'catalog with it'})`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const slot = { runtimeKey: c.runtimeA, directory: NEW, sessionId: null };
  await reloadInto({ projectId: 'gateway-new', directory: NEW, target: 'project' });
  writeChatDraft(slot, 'Draft in the new worktree', []);
  await act(async () => { c.remount(); await settle(); });
  await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await settle(); });
  if (lateCatalog) {
    await act(async () => { useProjectsStore.getState().applyManagedCatalog(existing); await settle(); await sleep(600); });
    expect(readChatDraft(slot).text).toBe('Draft in the new worktree');
  }
  await act(async () => { useProjectsStore.getState().applyManagedCatalog(withNew); await settle(); await sleep(600); });
  expect(readChatDraft(slot).text).toBe('Draft in the new worktree');
  expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(NEW);
  expect(c.text()).toBe('Draft in the new worktree');
});

// The field sequence (Astra pre-check): the page reloads INTO the new worktree (currentDirectory), whose project is
// not in the cached bookmarks, so the draft opens on the Chat side first and the composer restores Chat's empty
// draft; the editor's rewrite must not count as typing, or the catalog transfer saves the empty composer over the
// worktree's draft.
test('a reload into the new worktree keeps its draft through the Chat detour and the catalog transfer', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const slot = { runtimeKey: c.runtimeA, directory: NEW, sessionId: null };
  writeChatDraft(slot, 'Draft in the new worktree', []);
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  try {
    await act(async () => {
      useProjectsStore.getState().resetManagedCatalog();
      useProjectsStore.setState({ projects: [{ id: 'gateway-a', path: directory }], activeProjectId: 'gateway-a' });
      useDirectoryStore.setState({ currentDirectory: NEW });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      getDeferredSafeStorage().setItem('oc.chatInput.lastDraftTarget', JSON.stringify({ projectId: 'path_new', directory: NEW, target: 'project' }));
      useSessionUIStore.getState().openNewSessionDraft({ automatic: true });
      await settle();
    });
    await act(async () => { c.remount(); await settle(); await sleep(50); });
  } finally { home.mockRestore(); }
  expect(readChatDraft(slot).text).toBe('Draft in the new worktree');
  await act(async () => { useProjectsStore.getState().admitManagedCatalog(); useProjectsStore.getState().applyManagedCatalog(existing); await settle(); await sleep(600); });
  expect(readChatDraft(slot).text).toBe('Draft in the new worktree');
  await act(async () => { useProjectsStore.getState().applyManagedCatalog(withNew); await settle(); await sleep(600); });
  expect(readChatDraft(slot).text).toBe('Draft in the new worktree');
});
