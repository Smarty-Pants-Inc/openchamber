import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { opencodeClient } from '@/lib/opencode/client';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => sleep(0);
const rows = [{ id: 'gateway-a', worktree: directory }];
async function coldDraft(automatic = true) {
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  try {
    await act(async () => {
      useProjectsStore.getState().resetManagedCatalog();
      useProjectsStore.setState({ projects: [{ id: 'stale', path: '/stale-project' }], activeProjectId: 'stale' });
      useDirectoryStore.setState({ currentDirectory: '/stale-project' });
      opencodeClient.setDirectory('/stale-project');
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      getDeferredSafeStorage().removeItem('oc.chatInput.lastDraftTarget');
      // Same boot fallback action as ChatContainer, not a user New session click.
      useSessionUIStore.getState().openNewSessionDraft({ automatic });
      await settle();
    });
  } finally { home.mockRestore(); }
}

for (const edit of ['untouched', 'typed', 'cleared'] as const) test(`cold catalog restoration respects ${edit} input`, async () => {
  const live = edit === 'typed' ? 'New live input' : '';
  const c = mounted = await mountedNativeComposer(true);
  await coldDraft();
  const savedIdentity = { runtimeKey: c.runtimeA, directory, sessionId: null };
  writeChatDraft(savedIdentity, 'Saved @notes.md', new Set(['notes.md']));
  await act(async () => { c.remount(); await settle(); });
  if (edit !== 'untouched') await c.replace('New live input');
  if (edit === 'cleared') await c.replace('');
  const selection = c.editor().state.selection.toJSON();
  expect(readChatDraft(savedIdentity).text).toBe('Saved @notes.md');
  await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await settle(); });
  expect(readChatDraft(savedIdentity).text).toBe('Saved @notes.md');
  await act(async () => { useProjectsStore.getState().applyManagedCatalog(rows); await settle(); });
  const expected = edit === 'untouched' ? 'Saved @notes.md' : live;
  expect(c.text()).toBe(expected);
  expect(readChatDraft(savedIdentity).text).toBe(expected);
  if (edit === 'untouched') expect([...readChatDraft(savedIdentity).confirmedMentions]).toEqual(['notes.md']);
  else expect(c.editor().state.selection.toJSON()).toEqual(selection);
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
});

for (const choice of ['automatic', 'explicit', 'typed', 'target', 'absent', 'removed', 'runtime'] as const) test(`accepted session reload respects ${choice}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('One accepted input'); await c.submit(); await act(settle);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
  const creates = c.creates().length, prompts = c.prompts().length;
  await coldDraft(choice !== 'explicit');
  await act(async () => { c.remount(); await settle(); });
  if (choice === 'typed') await c.replace('New live draft');
  if (choice === 'target') await act(async () => { c.target('stale', '/stale-project'); await settle(); });
  if (choice === 'runtime') await act(async () => { c.switchRuntime('other-runtime'); await settle(); });
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await settle(); });
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog(choice === 'removed' ? [] : rows);
    useGlobalSessionsStore.getState().applyManagedSessions(['absent', 'removed'].includes(choice) ? [] : [session],
      useGlobalSessionsStore.getState().mutationRevision, new Set(choice === 'removed' ? [] : [directory]));
    await settle();
  });
  expect(useSessionUIStore.getState().currentSessionId).toBe(choice === 'automatic' ? session.id : null);
  if (choice !== 'runtime') expect(useSessionUIStore.getState().newSessionDraft.open).toBe(choice !== 'automatic');
  if (choice === 'typed') expect(c.text()).toBe('New live draft');
  if (choice === 'absent') {
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => {
      useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
      await settle();
    });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  }
  expect(c.creates()).toHaveLength(creates); expect(c.prompts()).toHaveLength(prompts);
});
