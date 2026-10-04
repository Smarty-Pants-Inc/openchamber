import { afterEach, expect, test } from 'bun:test';
import { doesNotThrow, rejects } from 'node:assert/strict';
import React, { act } from 'react';
import { useGitStore } from '@/stores/useGitStore';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { expectIdentity, known, none, pending, readIdentity } from './nativeDraftIdentity-record.test';
import { directory, draft, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { useInputStore } from '@/sync/input-store';
import { prepareNativeDraft, isNativeDraftTarget, assertManagedDraftTarget } from '@/sync/native-draft-creation';
import { startNativeDraft } from '@/sync/native-draft-start';
import { clearWorktreeBootstrapState, markWorktreeBootstrapPending } from '@/lib/worktrees/worktreeBootstrap';

const { useDraftTarget } = await import('@/components/chat/composer/state/useDraftTarget');

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let initialGit: ReturnType<typeof useGitStore.getState> | undefined;
let branch: ReturnType<typeof useDraftTarget> | undefined;
function BranchProbe() { branch = useDraftTarget(true); return null; }
afterEach(async () => {
  clearWorktreeBootstrapState(directory); await mounted?.dispose(); mounted = undefined;
  if (initialGit) useGitStore.setState(initialGit, true);
  initialGit = undefined; branch = undefined;
});
const bookmark = 'saved-bookmark-7', child = '/worktrees/org/topic';
const settle = () => act(async () => { await sleep(0); });
const setDraft = (change: Partial<typeof draft>) => useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, ...change } }));
async function mount(change: Partial<typeof draft> = {}, managed = true) {
  initialGit = useGitStore.getState();
  const c = mounted = await mountedNativeComposer(false, undefined, <BranchProbe />, undefined, f => {
    useProjectsStore.setState({ projects: [{ id: bookmark, path: directory }], activeProjectId: bookmark,
      managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedRows: null, managedProjects: null });
    if (managed) useProjectsStore.getState().applyManagedCatalog([{ id: 'root', worktree: directory },
      { id: 'child', worktree: child, parent: directory }, { id: 'foreign', worktree: '/foreign/topic', parent: '/other/root' }]);
    setDraft({ selectedProjectId: bookmark, directoryOverride: directory, ...change });
    f.handlers.create = async request => Response.json({ ...session,
      directory: new URL(request.url).searchParams.get('directory') });
  });
  await settle(); return c;
}
async function refused(c: Awaited<ReturnType<typeof mount>>, code: 'target' | 'unavailable') {
  const before = c.requests.length;
  await rejects(prepareNativeDraft(), { code });
  expect(c.requests).toHaveLength(before); expect(c.creates()).toHaveLength(0);
}

for (const managed of [false, true]) for (const path of [directory, child])
  test(`common composer exposes bookmarked root/raw override without branch leaves: managed ${managed}, ${path}`, async () => {
    const c = await mount(path === child
      ? { directoryOverride: path, preserveDirectoryOverride: true }
      : { directoryOverride: path }, managed);
    const before = useSessionUIStore.getState().newSessionDraft;
    expect(before.directoryOverride).toBe(path); expect(before.selectedProjectId).toBe(bookmark);
    expect(visibleProjects(useProjectsStore.getState()).some(p => p.id === bookmark && p.path === directory)).toBe(true);
    if (!branch) throw new Error('Actual client draft target probe missing');
    expect(branch.selectedDraftProject?.id).toBe(bookmark);
    expect(branch.selectedDraftProjectPath).toBe(directory);
    expect(branch.selectedDraftDirectory).toBe(path);
    expect(branch.projectRootBranchOption).toBeNull(); expect(branch.worktreeBranchOptions).toEqual([]);
    expect(branch.shouldShowDraftBranchSelector).toBe(false);
    expect(isNativeDraftTarget(before)).toBe(true); doesNotThrow(() => assertManagedDraftTarget(before));
    await prepareNativeDraft(); await prepareNativeDraft();
    expect(c.creates()).toHaveLength(1); expect(new URL(c.creates()[0].url).searchParams.get('directory')).toBe(path);
    expect(await c.creates()[0].clone().text()).toBe(''); expect(c.prompts()).toHaveLength(0);
    const input = useInputStore.getState(), store = useSessionUIStore.getState(), requests = c.requests.length;
    expectIdentity(c.dom.container, { state: 'resolved', reason: null, projectRoot: known(directory), directory: known(path), nativeTarget: true });
    for (let i = 0; i < 5; i++) readIdentity(c.dom.container);
    expect(c.requests).toHaveLength(requests); expect(useInputStore.getState()).toBe(input);
    expect(useSessionUIStore.getState()).toBe(store); // Read-only observations, not zero parent-mount IO.
  });

test('branch-present client selector rejects the absence oracle without refusing lawful identity', async () => {
  const c = await mount({}, false);
  await act(async () => {
    useGitStore.setState({ directories: new Map([[directory, { isGitRepo: true, status: null,
      branches: { all: ['main'], current: 'main', branches: { main: { current: true, name: 'main', commit: 'abc', label: 'main' } } },
      log: null, identity: null, diffCache: new Map(), indexRevision: 0, lastRepoCheckAt: Date.now(),
      lastStatusFetch: Date.now(), lastStatusChange: 0, lastLogFetch: 0, lastBranchesFetch: Date.now(), lastIdentityFetch: 0,
      logMaxCount: 0, isLoadingStatus: false, isLoadingLog: false, isLoadingBranches: false, isLoadingIdentity: false }]]) });
  });
  await settle();
  if (!branch) throw new Error('Actual client draft target probe missing');
  expect(branch.selectedDraftProject?.id).toBe(bookmark); expect(branch.selectedDraftProjectPath).toBe(directory);
  expect(branch.selectedDraftDirectory).toBe(directory);
  expect(branch.projectRootBranchOption).toEqual({ value: directory, label: 'main' });
  expect(branch.shouldShowDraftBranchSelector).toBe(true);
  expect(useGitStore.getState().directories.get(directory)?.isGitRepo).toBe(true);
  const current = useSessionUIStore.getState().newSessionDraft;
  expect(isNativeDraftTarget(current)).toBe(true); doesNotThrow(() => assertManagedDraftTarget(current));
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(directory), directory: known(directory), nativeTarget: true });
  expect(c.editor().contentDOM.getAttribute('contenteditable')).toBe('true'); expect(c.text()).toBe('');
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});
for (const path of ['/foreign/topic', directory + '/prefix-impostor', '/unlisted/topic'])
  test(`common witness rejects exact managed membership violation ${path}`, async () => {
    const c = await mount({ directoryOverride: path }); await refused(c, 'target');
    expectIdentity(c.dom.container, { state: 'inadmissible', reason: 'managed-directory-unadmitted',
      projectRoot: known(directory), directory: known(path), nativeTarget: true });
  });

test('pending worktree request is not none or an intended-path creation promise', async () => {
  const c = await mount({ pendingWorktreeRequestId: 'pending-1' }, false);
  expect(isNativeDraftTarget(useSessionUIStore.getState().newSessionDraft)).toBe(false); await refused(c, 'target');
  expectIdentity(c.dom.container, { state: 'pending', reason: 'worktree-request',
    projectRoot: known(directory), directory: pending, nativeTarget: false });
});

for (const managed of [false, true]) test(`bootstrap subscription preserves identity and actual shape; managed ${managed}`, async () => {
  markWorktreeBootstrapPending(directory);
  const c = await mount({ bootstrapPendingDirectory: directory }, managed);
  expect(isNativeDraftTarget(useSessionUIStore.getState().newSessionDraft)).toBe(managed);
  if (!managed) await refused(c, 'target');
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(directory), directory: known(directory), nativeTarget: managed });
  await act(async () => clearWorktreeBootstrapState(directory));
  expect(isNativeDraftTarget(useSessionUIStore.getState().newSessionDraft)).toBe(true);
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(directory), directory: known(directory), nativeTarget: true });
  expect(c.creates()).toHaveLength(0);
});

test('unlisted bootstrap directory reports pending catalog, never silently admits the tree', async () => {
  const path = '/new/unlisted';
  const c = await mount({ directoryOverride: path, bootstrapPendingDirectory: path });
  await refused(c, 'target');
  expectIdentity(c.dom.container, { state: 'pending', reason: 'worktree-catalog',
    projectRoot: known(directory), directory: known(path), nativeTarget: true });
});

for (const change of [{ open: false }, { target: 'chat' as const, selectedProjectId: null, directoryOverride: null }])
  test(`common mount emits explicit none for ${JSON.stringify(change)}`, async () => {
    const c = await mount(change, false); await refused(c, 'target');
    expectIdentity(c.dom.container, { state: 'none', reason: change.open === false ? 'closed' : 'no-project',
      projectRoot: none, directory: none, nativeTarget: false });
  });

for (const catalog of ['unknown', 'unavailable', 'null-rows', 'empty'] as const)
  test(`actual catalog ${catalog} is not conflated with successful no-project`, async () => {
    const c = await mount();
    await act(async () => {
      if (catalog === 'unknown') useProjectsStore.getState().resetManagedCatalog();
      else if (catalog === 'unavailable') useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
      else if (catalog === 'null-rows') useProjectsStore.setState({ managedRows: null, managedProjects: null });
      else useProjectsStore.getState().applyManagedCatalog([]);
    });
    if (catalog !== 'unknown') await refused(c, catalog === 'unavailable' ? 'unavailable' : 'target');
    else {
      const requests = c.requests.length; await rejects(startNativeDraft([]), { code: 'target' });
      expect(c.requests).toHaveLength(requests);
    }
    const record = readIdentity(c.dom.container);
    expect(record.state).toBe(catalog === 'empty' ? 'inadmissible' : catalog === 'unavailable' ? 'unavailable' : 'pending');
    expect(record.reason).toBe(catalog === 'empty' ? 'selected-project-missing' : catalog === 'unavailable' ? 'catalog-unavailable' : 'catalog-unanswered');
    expect(record.projectRoot).toEqual(catalog === 'empty' ? none : catalog === 'unavailable' || catalog === 'unknown' ? known(directory) : pending);
    expect(record.requestedDirectory).toBe(directory); expect(c.creates()).toHaveLength(0);
  });

test('answered ready empty catalog with no chosen project is none, unlike unresolved publication', async () => {
  const c = await mount();
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog([]);
    setDraft({ target: 'chat', selectedProjectId: null, directoryOverride: null });
  });
  await refused(c, 'target');
  expectIdentity(c.dom.container, { state: 'none', reason: 'no-project', projectRoot: none, directory: none, nativeTarget: false });
});
