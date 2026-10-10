import { doesNotThrow } from 'node:assert/strict';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { markWorktreeBootstrapPending, clearWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { useInputStore } from './input-store';
import { useSessionUIStore } from './session-ui-store';
import { assertManagedDraftTarget, isNativeDraftTarget, nativeCreationForDraft,
  prepareNativeDraft, preparedNativeDraft } from './native-draft-creation';
import { startNativeDraft } from './native-draft-start';
import { deferred, directory, draft, nativeDraftFixture, session } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { clearWorktreeBootstrapState(directory); fixture?.dispose(); fixture = undefined; });
async function errorCode(action: () => Promise<void>) {
  try { await action(); } catch (error) {
    if (error instanceof NativeCreationError) return error.code;
    throw error;
  }
  throw new Error('Expected native guard refusal');
}
async function startup(f: ReturnType<typeof nativeDraftFixture>) {
  // Join switchRuntimeEndpoint's actual in-flight promise; the unchanged fixture answers 404.
  await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('Failed to mint runtime URL auth token (404)');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].method).toBe('POST');
  expect(new URL(f.requests[0].url).pathname).toBe('/auth/url-token');
  expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
  return f.requests.length;
}
const bookmark = 'saved-bookmark-7';
const admit = (path = directory) => {
  useProjectsStore.setState({ projects: [{ id: bookmark, path }] });
  useProjectsStore.getState().applyManagedCatalog([{ id: 'server-root', worktree: path }]);
  useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: bookmark, directoryOverride: path } });
};

for (const requestIds of [false, true]) test(`real bookmarked root POST, exact args and no replay; request IDs ${requestIds}`, async () => {
  const f = fixture = nativeDraftFixture(); admit();
  const capabilities = requestIds ? { ordinaryCreateOnly: 1, creationClientRequestId: 1 } : { ordinaryCreateOnly: 1 };
  f.handlers.health = async () => Response.json({ healthy: true, capabilities });
  const create = spyOn(opencodeClient, 'createNativeSession'); // Spy through the actual SDK/transport.
  const before = useSessionUIStore.getState().newSessionDraft, input = useInputStore.getState();
  const id = '11234567-1234-4234-9234-012345678901';
  try {
    expect(visibleProjects(useProjectsStore.getState())[0]?.id).toBe(bookmark);
    expect(isNativeDraftTarget(before)).toBe(true); doesNotThrow(() => assertManagedDraftTarget(before));
    await prepareNativeDraft(id); await prepareNativeDraft(id);
    expect(create).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledWith(directory, requestIds ? id : undefined);
    expect(f.creates()).toHaveLength(1); const post = f.creates()[0];
    expect(new URL(post.url).searchParams.get('directory')).toBe(directory);
    expect(await post.clone().text()).toBe(requestIds ? JSON.stringify({ clientRequestId: id }) : '');
    expect(await preparedNativeDraft(before)).toEqual(session);
    expect(useSessionUIStore.getState().newSessionDraft).toBe(before); expect(useInputStore.getState()).toBe(input);
    expect(f.prompts()).toHaveLength(0);
  } finally { create.mockRestore(); }
});

for (const path of [directory, '/worktrees/org/topic']) test(`real managed root/child creation preserves tuple ${path}`, async () => {
  const f = fixture = nativeDraftFixture(); admit();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'root', worktree: directory },
    { id: 'child', worktree: '/worktrees/org/topic', parent: directory }]);
  useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: bookmark, directoryOverride: path } });
  f.handlers.create = async () => Response.json({ ...session, directory: path });
  await prepareNativeDraft();
  expect(new URL(f.creates()[0].url).searchParams.get('directory')).toBe(path);
  expect((await preparedNativeDraft(useSessionUIStore.getState().newSessionDraft))?.directory).toBe(path);
  expect(f.creates()).toHaveLength(1); expect(f.prompts()).toHaveLength(0);
});

for (const path of ['/foreign/topic', directory + '/prefix-impostor', '/unlisted/topic'])
  test(`foreign parent/prefix/unlisted refuses before support ${path}`, async () => {
    const f = fixture = nativeDraftFixture(); admit();
    useProjectsStore.getState().applyManagedCatalog([{ id: 'root', worktree: directory },
      { id: 'foreign', worktree: '/foreign/topic', parent: '/another/root' }]);
    useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: bookmark, directoryOverride: path } });
    const before = await startup(f);
    expect(await errorCode(() => prepareNativeDraft())).toBe('target');
    expect(f.requests).toHaveLength(before); expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
  });

for (const status of ['unavailable', 'unknown'] as const) test(`${status} managed guard precedes invalid target with zero IO`, async () => {
  const f = fixture = nativeDraftFixture(); admit();
  const before = await startup(f);
  useProjectsStore.setState({ managedCatalogStatus: status });
  useSessionUIStore.setState({ newSessionDraft: { ...draft, target: 'chat', selectedProjectId: null } });
  expect(await errorCode(() => prepareNativeDraft())).toBe('unavailable');
  expect(f.requests).toHaveLength(before); expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
});

for (const change of [{ open: false }, { target: 'chat' as const }, { selectedProjectId: 'missing' },
  { pendingWorktreeRequestId: 'request-1' }]) test(`stock invalid shape ${JSON.stringify(change)} precedes health`, async () => {
  const f = fixture = nativeDraftFixture();
  const before = await startup(f);
  useSessionUIStore.setState({ newSessionDraft: { ...draft, ...change } });
  expect(await errorCode(() => prepareNativeDraft())).toBe('target');
  expect(f.requests).toHaveLength(before); expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
});

test('real stock bootstrap refuses, clearing it admits; managed target ignores page wait', async () => {
  const f = fixture = nativeDraftFixture(); const before = await startup(f);
  markWorktreeBootstrapPending(directory);
  const marked = { ...draft, bootstrapPendingDirectory: directory };
  useSessionUIStore.setState({ newSessionDraft: marked });
  expect(isNativeDraftTarget(marked)).toBe(false);
  expect(await errorCode(() => prepareNativeDraft())).toBe('target'); expect(f.requests).toHaveLength(before);
  expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
  admit(); useSessionUIStore.setState({ newSessionDraft: { ...marked, selectedProjectId: bookmark } });
  expect(isNativeDraftTarget(useSessionUIStore.getState().newSessionDraft)).toBe(true);
  clearWorktreeBootstrapState(directory); await prepareNativeDraft(); expect(f.creates()).toHaveLength(1);
});

test('managed start actually waits for server bootstrap, not the page mark', async () => {
  const f = fixture = nativeDraftFixture(); admit();
  const entered = deferred<void>(), held = deferred<Response>();
  f.handlers.bootstrap = async () => { entered.resolve(); return held.promise; };
  const starting = errorCode(() => startNativeDraft([]));
  try { await entered.promise; expect(f.creates()).toHaveLength(0); }
  finally { held.resolve(Response.json({ status: 'ready', phase: 'setup-ready', error: null, updatedAt: 0 })); expect(await starting).toBe('notReady'); }
  expect(f.creates()).toHaveLength(1); expect(f.prompts()).toHaveLength(0);
});

for (const replacement of ['draft', 'runtime', 'catalog'] as const) test(`late support ${replacement} cannot create`, async () => {
  const f = fixture = nativeDraftFixture(); admit();
  const entered = deferred<void>(), held = deferred<Response>();
  f.handlers.health = async () => { entered.resolve(); return held.promise; };
  const result = errorCode(() => prepareNativeDraft());
  await entered.promise;
  if (replacement === 'runtime') f.switchRuntime('native-identity-other');
  else if (replacement === 'catalog') useProjectsStore.getState().applyManagedCatalog([]);
  else useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, draftId: 401 } });
  held.resolve(Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } }));
  expect(await result).toBe(replacement === 'catalog' ? 'target' : replacement === 'runtime' ? 'unavailable' : 'stale');
  expect(f.creates()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
});

test('detach and exact reattach retains original created record without another POST', async () => {
  const f = fixture = nativeDraftFixture(); await prepareNativeDraft();
  const original = useSessionUIStore.getState().newSessionDraft;
  const record = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, original, getRuntimeKey());
  useSessionUIStore.setState({ newSessionDraft: { ...original, open: false } });
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations,
    useSessionUIStore.getState().newSessionDraft, getRuntimeKey())).toBeNull();
  useSessionUIStore.setState({ newSessionDraft: original }); await prepareNativeDraft();
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, original, getRuntimeKey())).toBe(record);
  expect(f.creates()).toHaveLength(1); expect(f.prompts()).toHaveLength(0);
});
