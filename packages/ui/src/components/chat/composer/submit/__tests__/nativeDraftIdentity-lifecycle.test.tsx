import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { expectIdentity, known, none, readIdentity } from './nativeDraftIdentity-record.test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from '@/sync/input-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { directory, draft, deferred, session } from '@/sync/native-draft-fixture';
import { nativeCreationForDraft, prepareNativeDraft } from '@/sync/native-draft-creation';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => sleep(0);
const change = (patch: Partial<typeof draft>) => useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, ...patch } }));
async function cold() {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, () => {
    useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedRows: null, managedProjects: null });
  });
  await act(settle); return c;
}

test('draft replacement, selection, detach, remount and exact reattach do not reuse stale identity or create again', async () => {
  const c = await cold(); await prepareNativeDraft();
  const original = useSessionUIStore.getState().newSessionDraft;
  const owner = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, original, c.runtimeA);
  expect(owner?.status).toBe('created'); expect(c.creates()).toHaveLength(1);
  await act(async () => { change({ draftId: original.draftId + 1 }); await settle(); });
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations,
    useSessionUIStore.getState().newSessionDraft, c.runtimeA)).toBeNull();
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(directory), directory: known(directory), nativeTarget: true });
  expect(readIdentity(c.dom.container).draftId).toBe(original.draftId + 1);
  await act(async () => { c.target('b', '/native-project-b'); await settle(); });
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known('/native-project-b'), directory: known('/native-project-b'), nativeTarget: true });
  await act(async () => {
    change({ open: false }); useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: directory });
    await settle();
  });
  expectIdentity(c.dom.container, { state: 'none', reason: 'closed', projectRoot: none, directory: none, nativeTarget: false });
  await act(async () => { c.remount(); await settle(); });
  expectIdentity(c.dom.container, { state: 'none', reason: 'closed', projectRoot: none, directory: none, nativeTarget: false });
  await act(async () => {
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: original }); await settle();
  });
  await prepareNativeDraft();
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, original, c.runtimeA)).toBe(owner);
  expectIdentity(c.dom.container, { state: 'resolved', reason: null,
    projectRoot: known(directory), directory: known(directory), nativeTarget: true });
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
});

for (const navigation of ['draft', 'runtime'] as const) test(`held A support cannot publish old identity onto replacement ${navigation} B`, async () => {
  const c = await cold();
  const entered = deferred<void>(), held = deferred<Response>();
  c.handlers.health = async () => { entered.resolve(); return held.promise; };
  const creating = prepareNativeDraft().then(() => 'created', error => {
    if (error instanceof NativeCreationError) return error.code;
    throw error;
  });
  try {
    await entered.promise;
    await act(async () => {
      if (navigation === 'runtime') {
        c.switchRuntime('native-identity-runtime-b');
        useProjectsStore.setState({ projects: [{ id: 'b', path: '/native-project-b' }], activeProjectId: 'b', managedCatalogStatus: 'stock' });
        useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: 'b', directoryOverride: '/native-project-b' });
      } else c.target('b', '/native-project-b');
      change({ draftId: draft.draftId + 1 });
      await settle();
    });
    const replacement = useSessionUIStore.getState().newSessionDraft;
    expect(replacement.open).toBe(true); expect(replacement.target).toBe('project');
    expect(replacement.selectedProjectId).toBe('b'); expect(replacement.directoryOverride).toBe('/native-project-b');
    held.resolve(Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } }));
    await act(async () => { expect(await creating).toBe(navigation === 'runtime' ? 'unavailable' : 'stale'); await settle(); });
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
    const record = readIdentity(c.dom.container);
    expect(record.draftId).toBe(draft.draftId + 1); expect(record.selectedProjectId).toBe('b');
    expect(record.projectRoot).toEqual(known('/native-project-b')); expect(record.projectRoot).not.toEqual(known(directory));
    expect(record.runtimeKey).toBe(navigation === 'runtime' ? 'native-identity-runtime-b' : c.runtimeA);
  } finally {
    held.resolve(Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } })); await creating;
  }
});

test('repeated reads preserve actual stores and add no parent traffic or writes', async () => {
  const c = await cold();
  const before = c.requests.length, ui = useSessionUIStore.getState(), input = useInputStore.getState(), projects = useProjectsStore.getState();
  let writes = 0;
  const stops = [useSessionUIStore.subscribe(() => writes++), useInputStore.subscribe(() => writes++), useProjectsStore.subscribe(() => writes++)];
  try {
    for (let i = 0; i < 20; i++) expectIdentity(c.dom.container, { state: 'resolved', reason: null,
      projectRoot: known(directory), directory: known(directory), nativeTarget: true });
    expect(c.requests).toHaveLength(before); expect(writes).toBe(0);
    expect(useSessionUIStore.getState()).toBe(ui); expect(useInputStore.getState()).toBe(input); expect(useProjectsStore.getState()).toBe(projects);
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
  } finally { for (const stop of stops) stop(); }
});

for (const navigation of ['target', 'runtime'] as const) test(`late real POST A stays owned by A and cannot replace shown ${navigation} B`, async () => {
  const c = await cold(), entered = deferred<void>(), held = deferred<Response>();
  const original = useSessionUIStore.getState().newSessionDraft;
  c.handlers.create = async () => { entered.resolve(); return held.promise; };
  const creating = prepareNativeDraft();
  try {
    await entered.promise; expect(c.creates()).toHaveLength(1);
    await act(async () => {
      if (navigation === 'runtime') {
        c.switchRuntime('late-post-runtime-b');
        useProjectsStore.setState({ projects: [{ id: 'b', path: '/native-project-b' }], activeProjectId: 'b', managedCatalogStatus: 'stock' });
        useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: 'b', directoryOverride: '/native-project-b' });
      } else c.target('b', '/native-project-b');
      change({ draftId: draft.draftId + 1 }); await settle();
    });
    const replacement = useSessionUIStore.getState().newSessionDraft;
    expect(replacement.open).toBe(true); expect(replacement.target).toBe('project');
    expect(replacement.selectedProjectId).toBe('b'); expect(replacement.directoryOverride).toBe('/native-project-b');
    held.resolve(Response.json(session)); await act(async () => { await creating; await settle(); });
    expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, original, c.runtimeA)?.status).toBe('created');
    if (navigation === 'runtime') expect(useGlobalSessionsStore.getState().entityById.has(session.id)).toBe(false);
    const current = readIdentity(c.dom.container);
    expect(current.selectedProjectId).toBe('b'); expect(current.projectRoot).toEqual(known('/native-project-b'));
    expect(current.directory).toEqual(known('/native-project-b')); expect(current.draftId).toBe(draft.draftId + 1);
    expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  } finally { held.resolve(Response.json(session)); await creating; }
});
