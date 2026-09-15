import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useInputStore } from './input-store';
import { useSessionUIStore, materializeOpenDraftSession, type NewSessionDraftState } from './session-ui-store';
import { nativeCreationForDraft, prepareNativeDraft, preparedNativeDraft } from './native-draft-creation';

const directory = '/synthetic-project';
const session: NativeCreatedSession = { id: '01234567-1234-4234-9234-012345678901', slug: 'native', projectID: 'p', directory,
  title: 'Pi', version: '1', time: { created: 1, updated: 1 },
  nativeCreation: { model: { providerID: 'native-provider', modelID: 'native-model' }, inputReady: false } };
const draft: NewSessionDraftState = { draftId: 1, open: true, target: 'project', selectedProjectId: 'p',
  directoryOverride: directory, parentID: null, initialPrompt: 'Retain this draft', syntheticParts: [{ text: 'retained context', synthetic: true }] };
const initialUI = useSessionUIStore.getState(), initialProjects = useProjectsStore.getState();
const initialGlobal = useGlobalSessionsStore.getState(), initialInput = useInputStore.getState();
const health = spyOn(opencodeClient, 'supportsNativeCreation');
const create = spyOn(opencodeClient, 'createNativeSession');
const legacy = spyOn(opencodeClient, 'createSession');
const prompt = spyOn(opencodeClient, 'sendMessage');
const fetchMock = spyOn(globalThis, 'fetch');

beforeEach(() => {
  // No network or provider can escape this fixture, including incidental configuration reads.
  fetchMock.mockImplementation(async () => { throw new Error('No network allowed'); });
  health.mockResolvedValue(true); create.mockResolvedValue(session);
  legacy.mockImplementation(async () => { throw new Error('Unexpected legacy creation'); });
  prompt.mockImplementation(async () => { throw new Error('No prompt allowed'); });
  useProjectsStore.setState({ projects: [{ id: 'p', path: directory }], activeProjectId: 'p' });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft }, nativeDraftCreation: null });
  useInputStore.setState({ pendingInputText: 'Retain typed text', pendingSyntheticParts: draft.syntheticParts ?? null });
});
afterEach(() => {
  useSessionUIStore.setState(initialUI, true); useProjectsStore.setState(initialProjects, true);
  useGlobalSessionsStore.setState(initialGlobal, true); useInputStore.setState(initialInput, true);
  for (const mock of [health, create, legacy, prompt, fetchMock]) mock.mockReset();
});

test('create-only needs no selected model, leaves the draft intact and indexes the attached native owner', async () => {
  const before = useSessionUIStore.getState().newSessionDraft, input = useInputStore.getState();
  await prepareNativeDraft();
  expect(create).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledWith(directory);
  expect(legacy).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
  expect(useSessionUIStore.getState().newSessionDraft).toBe(before);
  expect(useInputStore.getState()).toBe(input);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useGlobalSessionsStore.getState().activeSessions.some(row => row.id === session.id)).toBe(true);
  expect(await preparedNativeDraft(before)).toEqual(session);
  await prepareNativeDraft(); expect(create).toHaveBeenCalledTimes(1);
});

test('ordinary Send refuses before creation or prompt; later explicit materialization reuses the created owner', async () => {
  await expect(useSessionUIStore.getState().sendMessage('unsent', 'unused', 'unused')).rejects.toBeInstanceOf(NativeCreationError);
  expect(create).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
  await prepareNativeDraft();
  await expect(materializeOpenDraftSession({ providerID: 'other', modelID: 'other' })).rejects.toBeInstanceOf(NativeCreationError);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
  const result = await materializeOpenDraftSession(session.nativeCreation.model);
  expect(result).toEqual({ sessionId: session.id, directory, syntheticParts: draft.syntheticParts });
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(create).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
});

test('in-flight duplicate actions do not submit again', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  create.mockImplementation(async () => { await wait; return session; });
  const first = prepareNativeDraft(); await Bun.sleep(0);
  await prepareNativeDraft(); expect(create).toHaveBeenCalledTimes(1);
  health.mockResolvedValue(false);
  await expect(preparedNativeDraft(draft)).rejects.toBeInstanceOf(NativeCreationError);
  release(); await first; expect(prompt).not.toHaveBeenCalled();
});

test('unknown outcome stays actionable with the same draft and cannot be silently retried', async () => {
  const error = new NativeCreationError('unknown', undefined, 'Inspect w1:p2 /private/native-one/session.jsonl. Do not retry automatically.');
  create.mockRejectedValue(error);
  await expect(prepareNativeDraft()).rejects.toBe(error);
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
  const state = useSessionUIStore.getState().nativeDraftCreation;
  expect(state?.status).toBe('failed');
  if (state?.status === 'failed') expect(state.error.detail).toBe(error.detail);
  await prepareNativeDraft(); expect(create).toHaveBeenCalledTimes(1);
  await expect(preparedNativeDraft(draft)).rejects.toBe(error);
  expect(prompt).not.toHaveBeenCalled();
});

test('missing capability and changed project target refuse before effects', async () => {
  health.mockResolvedValue(false);
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  expect(create).not.toHaveBeenCalled();
  useSessionUIStore.setState({ nativeDraftCreation: null });
  health.mockImplementation(async () => {
    useSessionUIStore.setState({ newSessionDraft: { ...draft, directoryOverride: '/other-project' } });
    return true;
  });
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  expect(create).not.toHaveBeenCalled();
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreation, draft, 'another-runtime')).toBeNull();
});

test('invalid targets and failed capability reads cannot create or fall back to legacy', async () => {
  for (const change of [{ target: 'worktree' as const }, { title: 'title' }, { parentID: 'parent' },
    { selectedProjectId: null }, { pendingWorktreeRequestId: 'pending' }, { bootstrapPendingDirectory: directory }]) {
    useSessionUIStore.setState({ newSessionDraft: { ...draft, ...change } });
    await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  }
  expect(health).not.toHaveBeenCalled();
  useSessionUIStore.setState({ newSessionDraft: { ...draft } });
  health.mockRejectedValue(new Error('offline'));
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  await expect(preparedNativeDraft(draft)).rejects.toBeInstanceOf(NativeCreationError);
  expect(create).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
});

test('a mismatched returned directory remains an unknown outcome without publication or another POST', async () => {
  const before = useGlobalSessionsStore.getState().activeSessions;
  create.mockResolvedValue({ ...session, directory: '/other-project' });
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  const state = useSessionUIStore.getState().nativeDraftCreation;
  if (state?.status !== 'failed') throw new Error('Expected retained failure');
  expect(state.error.reference).toEqual({ id: session.id, directory: '/other-project' });
  expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
  await prepareNativeDraft(); expect(create).toHaveBeenCalledTimes(1);
});

test('Send with an inherited project target still checks that project capability before any creation', async () => {
  await expect(preparedNativeDraft({ ...draft, directoryOverride: null })).rejects.toBeInstanceOf(NativeCreationError);
  expect(health).toHaveBeenCalledWith(directory);
  expect(create).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
});

test('legacy backend keeps the existing draft materialization path', async () => {
  health.mockResolvedValue(false);
  expect(await preparedNativeDraft(draft)).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

test('runtime change after submission cannot publish the returned session into another runtime', async () => {
  const before = useGlobalSessionsStore.getState().activeSessions;
  create.mockImplementation(async () => {
    // Module-local test identity only. No endpoint switch, transport or native session is started.
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: 'different-test-runtime' });
    return session;
  });
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(create).toHaveBeenCalledTimes(1); expect(prompt).not.toHaveBeenCalled();
});
