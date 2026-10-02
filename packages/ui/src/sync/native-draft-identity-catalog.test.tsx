import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '@opencode-ai/sdk/v2';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { createWebAPIs } from '../../../web/src/api';
import { expectIdentity, known, pending, readIdentity } from '@/components/chat/composer/submit/__tests__/nativeDraftIdentity-record.test';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { deferred, draft } from './native-draft-fixture';
import { assertManagedDraftTarget } from './native-draft-creation';

// Capture the production hook before the composer fixture installs its unrelated runtime stub.
const runtimeHooks = await import('@/hooks/useRuntimeAPIs');
const realUseRuntimeAPIs = runtimeHooks.useRuntimeAPIs;
const { mountedNativeComposer } = await import('@/components/chat/composer/submit/__tests__/nativeComposer.fixture');
const { ChatInput } = await import('@/components/chat/ChatInput');
const { useDraftTarget } = await import('@/components/chat/composer/state/useDraftTarget');
const runtimeProbe = spyOn(runtimeHooks, 'useRuntimeAPIs').mockImplementation(realUseRuntimeAPIs);
afterAll(() => runtimeProbe.mockRestore());

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; chooser = undefined; });
const prior = '/prior/org', accepted = '/accepted/org';
const oldID = 'bookmark-old-not-a-path', newID = 'bookmark-new-not-a-path';
let chooser: ReturnType<typeof useDraftTarget> | undefined;
function Chooser() { chooser = useDraftTarget(true); return null; }
function ClientComposer() {
  const [apis] = React.useState(() => createWebAPIs({ urls: getRuntimeUrlResolver() }));
  return <RuntimeAPIProvider apis={apis}><ChatInput /><Chooser /></RuntimeAPIProvider>;
}
function actualChooser() {
  if (!chooser) throw new Error('Real draft hook was not client-mounted');
  return chooser;
}
const tick = () => sleep(0);

test('F2 held real global publication exposes OLD applied root and refuses expected new root before input', async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, () => <ClientComposer />, () => {
    useProjectsStore.setState({ projects: [{ id: oldID, path: prior }, { id: newID, path: accepted }], activeProjectId: oldID });
    useProjectsStore.getState().applyManagedCatalog([{ id: 'prior', worktree: prior, name: 'org (Paul)' }]);
    useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: oldID,
      directoryOverride: prior, preserveDirectoryOverride: true, initialPrompt: undefined } });
  });
  const sdk = opencodeClient.getSdkClient(), entered = deferred<void>(), globalRead = deferred<Session[]>();
  const newRows = [{ id: 'accepted', worktree: accepted, name: 'org (Paul)', time: { created: 1, updated: 1 }, sandboxes: [] }];
  const projects = spyOn(sdk.project, 'list').mockImplementation(async options => {
    expect(options).toBeUndefined();
    return { data: newRows, request: new Request('http://synthetic.invalid/project'),
      response: new Response(null, { headers: { 'x-smarty-code-catalog': 'managed-v1' } }) };
  });
  const sessions = spyOn(sdk.experimental.session, 'list').mockImplementation(async options => {
    expect(options?.directory).toBeUndefined(); entered.resolve();
    return { data: (await globalRead.promise).map(row => ({ ...row, project: null })),
      request: new Request('http://synthetic.invalid/experimental/session'), response: new Response() };
  });
  let refreshing: Promise<void> | undefined;
  try {
    await act(async () => { refreshing = refreshManagedProjects(true); await entered.promise; await tick(); });
    const independentlyRead = await sdk.project.list(); // Returned rows are not browser publication.
    expect(independentlyRead.data?.[0].worktree).toBe(accepted);
    expect(visibleProjects(useProjectsStore.getState())[0]).toMatchObject({ id: oldID, path: prior, label: 'org (Paul)' });
    const heldDraft = useSessionUIStore.getState().newSessionDraft;
    await act(async () => actualChooser().handleDraftProjectChange(oldID)); // ONE actual preserved/no-op choice.
    expect(useSessionUIStore.getState().newSessionDraft).toBe(heldDraft);
    assert.doesNotThrow(() => assertManagedDraftTarget(heldDraft)); // Old applied creation remains lawful.
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
    const record = expectIdentity(c.dom.container, { state: 'resolved', reason: null,
      projectRoot: known(prior), directory: known(prior), nativeTarget: true });
    expect(record.projectRoot).not.toEqual(known(accepted));
    expect(record.state === 'resolved' && record.projectRoot.value === accepted && record.directory.value === accepted).toBe(false);
    expect(c.text()).toBe(''); // Consumer refuses expected target before typing or Send, not a product admission gate.
    await act(async () => { globalRead.resolve([]); await refreshing; await tick(); });
    expect(visibleProjects(useProjectsStore.getState())[0]).toMatchObject({ id: newID, path: accepted });
    await act(async () => {
      useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, preserveDirectoryOverride: false } }));
      actualChooser().handleDraftProjectChange(newID); // ONE applied valid project choice after publication.
      await tick();
    });
    const current = useSessionUIStore.getState().newSessionDraft;
    expect(current).toMatchObject({ selectedProjectId: newID, directoryOverride: accepted });
    assert.doesNotThrow(() => assertManagedDraftTarget(current));
    const applied = expectIdentity(c.dom.container, { state: 'resolved', reason: null,
      projectRoot: known(accepted), directory: known(accepted), nativeTarget: true });
    expect(applied.state === 'resolved' && applied.projectRoot.value === accepted && applied.directory.value === accepted).toBe(true);
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0); expect(c.text()).toBe('');
  } finally {
    globalRead.resolve([]); if (refreshing) await refreshing;
    sessions.mockRestore(); projects.mockRestore();
  }
});

for (const preserve of [false, true]) test(`ONE real same-default chooser is lawful; preserve ${preserve}, no mirror prerequisite`, async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, () => <ClientComposer />, () => {
    useProjectsStore.setState({ projects: [{ id: oldID, path: prior }], activeProjectId: oldID });
    useProjectsStore.getState().applyManagedCatalog([{ id: 'root', worktree: prior }]);
    useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: oldID, directoryOverride: prior,
      preserveDirectoryOverride: preserve, initialPrompt: undefined } });
  });
  const old = useSessionUIStore.getState().newSessionDraft;
  await act(async () => { actualChooser().handleDraftProjectChange(oldID); await tick(); });
  expect(useSessionUIStore.getState().newSessionDraft).toMatchObject({ selectedProjectId: oldID, directoryOverride: prior });
  if (preserve) expect(useSessionUIStore.getState().newSessionDraft).toBe(old);
  assert.doesNotThrow(() => assertManagedDraftTarget(useSessionUIStore.getState().newSessionDraft));
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(prior), directory: known(prior), nativeTarget: true });
  const requests = c.requests.length; readIdentity(c.dom.container); readIdentity(c.dom.container);
  expect(c.requests).toHaveLength(requests);
});

for (const flag of ['pendingWorktreeRequestId', 'bootstrapPendingDirectory'] as const)
  test(`ONE actual chooser cannot override pending ${flag}`, async () => {
    const c = mounted = await mountedNativeComposer(false, undefined, undefined, () => <ClientComposer />, () => {
      useProjectsStore.setState({ projects: [{ id: oldID, path: prior }, { id: newID, path: accepted }], activeProjectId: oldID });
      useProjectsStore.getState().applyManagedCatalog([{ id: 'prior', worktree: prior }, { id: 'new', worktree: accepted }]);
      useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: oldID, directoryOverride: prior,
        [flag]: flag === 'bootstrapPendingDirectory' ? prior : 'worktree-1', initialPrompt: undefined } });
    });
    const before = useSessionUIStore.getState().newSessionDraft;
    await act(async () => { actualChooser().handleDraftProjectChange(newID); await tick(); });
    expect(useSessionUIStore.getState().newSessionDraft).toBe(before); expect(c.creates()).toHaveLength(0);
    const requesting = flag === 'pendingWorktreeRequestId';
    expectIdentity(c.dom.container, { state: requesting ? 'pending' : 'resolved', reason: requesting ? 'worktree-request' : null,
      projectRoot: known(prior), directory: requesting ? pending : known(prior), nativeTarget: !requesting });
  });
