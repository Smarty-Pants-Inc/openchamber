import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { opencodeClient } from '@/lib/opencode/client';
import { createProjectIdFromPath } from '@/lib/projectId';
import type { useSyncRuntime } from '@/sync/sync-context';
import { claimChatDraftOwnership, createChatDraftIdentity, writeChatDraft } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';

mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => { throw new Error('Unexpected model panel'); }, preloadProviderLogos: () => undefined }));
const { ChatContainer } = await import('@/components/chat/ChatContainer');
type RuntimeValue = ReturnType<typeof useSyncRuntime>;
// SAFETY: sync-context publishes these keys with RuntimeValue; parent checks both contexts before rendering.
const globals = globalThis as typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(RuntimeValue & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<RuntimeValue | null>;
};
const System = globals.__openchamber_sync_context__, Runtime = globals.__openchamber_sync_runtime_context__;
const net = { id: createProjectIdFromPath('/projects/net'), path: '/projects/net', label: 'Net' };
const owned = { id: createProjectIdFromPath('/projects/owned-draft'), path: '/projects/owned-draft', label: 'Owned draft' };
const key = 'oc.chatInput.lastDraftTarget';
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let primed = '';
function parent(fixture: Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[3]>>[0]) {
  if (!System || !Runtime) throw new Error('Actual sync context seam unavailable');
  const runtime: RuntimeValue = { childStores: fixture.children, messageLoader: fixture.loader,
    sdk: opencodeClient.getSdkClient(), runtimeKey: fixture.runtimeA,
    currentDirectory: { get: () => net.path, subscribe: () => () => undefined } };
  return <System.Provider value={{ ...runtime, directory: net.path }}><Runtime.Provider value={runtime}>
    <ChatContainer messagesEnabled={false} />
  </Runtime.Provider></System.Provider>;
}
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

for (const discovery of ['unknown', 'stock', 'ready'] as const) test(`automatic open keeps remembered project while catalog is ${discovery}`, async () => {
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net, owned], activeProjectId: net.id });
    if (discovery === 'ready') useProjectsStore.getState().applyManagedCatalog([
      { id: 'gateway-net', worktree: net.path }, { id: 'gateway-owned', worktree: owned.path },
    ]);
    else useProjectsStore.setState({ managedCatalogStatus: discovery });
    // Establish intent with the same supported action as the visible project picker.
    useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: owned.id, directoryOverride: owned.path });
    primed = getDeferredSafeStorage().getItem(key)!;
    useSessionUIStore.getState().closeNewSessionDraft();
    useDirectoryStore.setState({ currentDirectory: net.path });
    opencodeClient.setDirectory(net.path);
  });
  // No open action, forced effect, pointer or typing before these assertions.
  // ChatContainer's automatic effect owns the open; ChatInput's real effects settle normally.
  expect(useProjectsStore.getState().managedCatalogStatus).toBe(discovery);
  expect(useProjectsStore.getState().managedCatalogAdmitted).toBe(discovery === 'ready');
  const snapshot = () => {
    const draft = useSessionUIStore.getState().newSessionDraft;
    return { live: { projectId: draft.selectedProjectId, directory: draft.directoryOverride, target: draft.target },
      saved: JSON.parse(getDeferredSafeStorage().getItem(key)!) };
  };
  expect(snapshot()).toEqual({ live: JSON.parse(primed), saved: JSON.parse(primed) });
  if (discovery === 'unknown') {
    await act(async () => useProjectsStore.getState().applyManagedCatalog([
      { id: 'gateway-net', worktree: net.path }, { id: 'gateway-owned', worktree: owned.path },
    ]));
    expect(snapshot()).toEqual({ live: JSON.parse(primed), saved: JSON.parse(primed) });
  }
  // A subsequent global click keeps that choice; an explicit different choice still wins.
  await act(async () => useSessionUIStore.getState().openNewSessionDraft());
  expect(snapshot()).toEqual({ live: JSON.parse(primed), saved: JSON.parse(primed) });
  await act(async () => useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: net.id, directoryOverride: net.path }));
  const explicit = { projectId: net.id, directory: net.path, target: 'project' };
  expect(snapshot()).toEqual({ live: explicit, saved: explicit });
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});

// smarty-code#113 (Release 1): after a reload the remembered project is not yet in the cached
// project view (only settings-listed projects are), so the automatic open waits as a Chat draft.
// When the managed catalog publishes, the draft must return to the remembered project, not to
// the shared active project, and the remembered record must survive that wait.
test('reload before catalog: automatic open returns to the remembered project the catalog admits', async () => {
  const remembered = JSON.stringify({ projectId: owned.id, directory: owned.path, target: 'project' });
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net], activeProjectId: net.id, managedCatalogStatus: 'unknown' });
    useSessionUIStore.getState().closeNewSessionDraft();
    getDeferredSafeStorage().setItem(key, remembered);
    // The unsent text typed before the reload, stored under the remembered project's slot.
    const slot = createChatDraftIdentity(getRuntimeKey(), owned.path, null, -113);
    claimChatDraftOwnership(slot); writeChatDraft(slot, 'unsent draft text', []);
    useDirectoryStore.setState({ currentDirectory: net.path });
    opencodeClient.setDirectory(net.path);
  });
  expect(getDeferredSafeStorage().getItem(key)).toBe(remembered);
  await act(async () => useProjectsStore.getState().applyManagedCatalog([
    { id: 'gateway-net', worktree: net.path }, { id: 'gateway-owned', worktree: owned.path },
  ]));
  const draft = useSessionUIStore.getState().newSessionDraft;
  expect({ projectId: draft.selectedProjectId, directory: draft.directoryOverride, target: draft.target })
    .toEqual({ projectId: owned.id, directory: owned.path, target: 'project' });
  expect(JSON.parse(getDeferredSafeStorage().getItem(key)!)).toEqual(JSON.parse(remembered));
  expect(mounted.text()).toBe('unsent draft text');
  // The rest of the app follows the draft, not the shared active project.
  await act(async () => { await Promise.resolve(); });
  expect(useProjectsStore.getState().activeProjectId).toBe(owned.id);
  expect(useDirectoryStore.getState().currentDirectory).toBe(owned.path);
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});

// smarty-code#113 (Release 3.12): the remembered project is a NESTED catalog worktree whose parent is a cached
// bookmark. Before discovery the cached view resolved the worktree to its parent by path, opened the draft there
// and recorded the parent over the remembered target. It must wait for the catalog and return to the child.
for (const admitted of [false, true]) test(`reload before catalog: a remembered nested worktree is restored, not its parent (admitted early: ${admitted})`, async () => {
  const child = { id: createProjectIdFromPath('/projects/net/.worktrees/child'), path: '/projects/net/.worktrees/child' };
  const remembered = JSON.stringify({ projectId: child.id, directory: child.path, target: 'project' });
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net], activeProjectId: net.id, managedCatalogStatus: 'unknown' });
    if (admitted) useProjectsStore.getState().admitManagedCatalog();
    useSessionUIStore.getState().closeNewSessionDraft();
    getDeferredSafeStorage().setItem(key, remembered);
    const slot = createChatDraftIdentity(getRuntimeKey(), child.path, null, -1131);
    claimChatDraftOwnership(slot); writeChatDraft(slot, 'unsent nested text', []);
    useDirectoryStore.setState({ currentDirectory: net.path });
    opencodeClient.setDirectory(net.path);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(getDeferredSafeStorage().getItem(key)).toBe(remembered);
  expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).not.toBe(net.id);
  await act(async () => useProjectsStore.getState().applyManagedCatalog([
    { id: 'gateway-net', worktree: net.path }, { id: 'gateway-child', worktree: child.path, parent: net.path },
  ]));
  const draft = useSessionUIStore.getState().newSessionDraft;
  expect({ projectId: draft.selectedProjectId, directory: draft.directoryOverride, target: draft.target })
    .toEqual({ projectId: child.id, directory: child.path, target: 'project' });
  expect(JSON.parse(getDeferredSafeStorage().getItem(key)!)).toEqual(JSON.parse(remembered));
  expect(mounted.text()).toBe('unsent nested text');
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});

// review/astra on OC#159: a bootstrap settings sync that completes AFTER the catalog restored the nested child names
// the parent as the shared lastDirectory, and has already mirrored it into local `lastDirectory`. The app must stay on
// the child (its own last choice), and the restoration must send no settings write.
test('reload before catalog: a late bootstrap settings sync keeps the restored nested worktree', async () => {
  const child = { id: createProjectIdFromPath('/projects/net/.worktrees/child'), path: '/projects/net/.worktrees/child' };
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net], activeProjectId: net.id, managedCatalogStatus: 'unknown' });
    useSessionUIStore.getState().closeNewSessionDraft();
    getDeferredSafeStorage().setItem(key, JSON.stringify({ projectId: child.id, directory: child.path, target: 'project' }));
    // This browser picked the child before the reload (an earlier page life).
    getDeferredSafeStorage().setItem('oc.browser.lastDirectory', child.path);
    const slot = createChatDraftIdentity(getRuntimeKey(), child.path, null, -1132);
    claimChatDraftOwnership(slot); writeChatDraft(slot, 'unsent nested text', []);
    useDirectoryStore.setState({ currentDirectory: net.path });
    opencodeClient.setDirectory(net.path);
  });
  await act(async () => useProjectsStore.getState().applyManagedCatalog([
    { id: 'gateway-net', worktree: net.path }, { id: 'gateway-child', worktree: child.path, parent: net.path },
  ]));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // The late bootstrap sync, in syncDesktopSettings' order: the local mirror first, then the settings event.
  getDeferredSafeStorage().setItem('lastDirectory', net.path);
  await act(async () => {
    useProjectsStore.getState().synchronizeFromSettings({ lastDirectory: net.path, activeProjectId: net.id, projects: [net] },
      { adoptActiveProject: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const draft = useSessionUIStore.getState().newSessionDraft;
  expect({ projectId: draft.selectedProjectId, directory: draft.directoryOverride, target: draft.target })
    .toEqual({ projectId: child.id, directory: child.path, target: 'project' });
  expect(mounted.text()).toBe('unsent nested text');
  expect(useProjectsStore.getState().activeProjectId).toBe(child.id);
  expect(useDirectoryStore.getState().currentDirectory).toBe(child.path);
  expect(mounted.requests.filter((request) => request.method !== 'GET' && new URL(request.url).pathname.endsWith('/config/settings'))).toEqual([]);
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});

for (const outcome of ['not admitted', 'stock'] as const) test(`reload before catalog: remembered project ${outcome} falls back to the previous rule`, async () => {
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net], activeProjectId: net.id, managedCatalogStatus: 'unknown' });
    useSessionUIStore.getState().closeNewSessionDraft();
    getDeferredSafeStorage().setItem(key, JSON.stringify({ projectId: owned.id, directory: owned.path, target: 'project' }));
    useDirectoryStore.setState({ currentDirectory: net.path });
    opencodeClient.setDirectory(net.path);
  });
  await act(async () => {
    if (outcome === 'stock') useProjectsStore.setState({ managedCatalogStatus: 'stock' });
    else useProjectsStore.getState().applyManagedCatalog([{ id: 'gateway-net', worktree: net.path }]);
  });
  const draft = useSessionUIStore.getState().newSessionDraft;
  const saved = JSON.parse(getDeferredSafeStorage().getItem(key)!);
  if (outcome === 'stock') {
    expect(draft.target).toBe('chat');
    expect(saved).toEqual({ projectId: null, directory: null, target: 'chat' });
  } else {
    expect({ projectId: draft.selectedProjectId, directory: draft.directoryOverride, target: draft.target })
      .toEqual({ projectId: net.id, directory: net.path, target: 'project' });
    expect(saved).toEqual({ projectId: net.id, directory: net.path, target: 'project' });
  }
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});

// review/astra on smarty-code#163: keeping the remembered target is for the implicit automatic
// open only. An explicit New Chat choice while the catalog is pending is recorded at once.
test('reload before catalog: an explicit New Chat choice is recorded and stays Chat', async () => {
  mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [net], activeProjectId: net.id, managedCatalogStatus: 'unknown' });
    useSessionUIStore.getState().closeNewSessionDraft();
    getDeferredSafeStorage().setItem(key, JSON.stringify({ projectId: owned.id, directory: owned.path, target: 'project' }));
    // No current directory, so stale-directory recovery cannot repair the record for the test.
    useDirectoryStore.setState({ currentDirectory: '' });
  });
  const saved = () => JSON.parse(getDeferredSafeStorage().getItem(key)!) as { projectId: string | null; directory: string | null; target: string };
  // The store records the explicit choice itself, before any composer effect runs.
  await act(async () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null });
    expect(saved()).toEqual({ projectId: null, directory: null, target: 'chat' });
  });
  expect(saved()).toMatchObject({ projectId: null, target: 'chat' });
  await act(async () => useProjectsStore.getState().applyManagedCatalog([
    { id: 'gateway-net', worktree: net.path }, { id: 'gateway-owned', worktree: owned.path },
  ]));
  expect(useSessionUIStore.getState().newSessionDraft.target).toBe('chat');
  expect(saved()).toMatchObject({ projectId: null, target: 'chat' });
  expect(mounted.creates()).toHaveLength(0);
  expect(mounted.prompts()).toHaveLength(0);
});
