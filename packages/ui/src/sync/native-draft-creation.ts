import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreatedSession, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { createNativeSession } from './session-actions';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

type DraftTarget = { runtimeKey: string; draftId: number; directory: string; projectId: string };
export type NativeDraftCreation = DraftTarget & (
  | { status: 'creating' | 'checking' }
  | { status: 'failed'; error: NativeCreationError; submitted: boolean }
  | { status: 'created'; session: NativeCreatedSession; inputAccepted?: true;
      /** The start's request id: every Send to this session, retries too, carries its sent mark (#117). */
      clientRequestId?: string }
  | { status: 'pending'; operation: NativeCreationState; busy?: boolean; error?: NativeCreationError;
      /** The last read answered 'unavailable' (its owner not readable yet), or showed no newer state than a reply
       * already sent: re-read only, never answer (#126). */
      unreadable?: boolean;
      /** The revision this record last replied to; a reply is never sent again at or below it (no replay). */
      answered?: number;
      /** 'ready' was answered: the owner arms input and reports 'ready' a moment later; it is never answered twice. */
      readyReplied?: true }
);

/** Phases known to have started nothing that could take a message. */
export const STOPPED_PHASES = ['denied', 'cancelled', 'expired'];
/** Starts this page settled into its own sessions, per server: never "another start still running here" (smarty-code#114). */
export const ownSettledStarts = new Set<string>();
export const settledStartKey = (runtimeKey: string, operationId: string) => `${runtimeKey}\0${operationId}`;
/**
 * Starts still running in a project that are not this page's own settled ones. Send refuses a new start while any is
 * (the server refuses a second one meanwhile), and the composer says so; both use this one rule.
 */
export function startsElsewhere(operations: readonly NativeCreationState[], runtimeKey: string, directory?: string | null): NativeCreationState[] {
  return operations.filter(operation => (directory === undefined || operation.directory === directory)
    && operation.phase !== 'ready' && !STOPPED_PHASES.includes(operation.phase)
    && !ownSettledStarts.has(settledStartKey(runtimeKey, operation.operationId)));
}

export function isNativeDraftTarget(draft: NewSessionDraftState): boolean {
  return draft.open && draft.target === 'project' && Boolean(draft.directoryOverride && draft.selectedProjectId)
    && !draft.parentID && !draft.title && !draft.pendingWorktreeRequestId && !draft.bootstrapPendingDirectory;
}

export function assertManagedDraftTarget(draft: NewSessionDraftState, directory = draft.directoryOverride): void {
  const state = useProjectsStore.getState();
  if (!state.managedCatalogAdmitted) return;
  if (state.managedCatalogStatus !== 'ready') throw new NativeCreationError('unavailable');
  const project = visibleProjects(state).find(project => project.id === draft.selectedProjectId);
  if (draft.target !== 'project' || !project || directory !== project.path
    || draft.directoryOverride !== project.path) throw new NativeCreationError('target');
}

function targetKey(target: DraftTarget): string {
  return JSON.stringify([target.runtimeKey, target.draftId, target.projectId, target.directory]);
}

/** Live browser memory only. Target/runtime navigation and remount must not erase an outcome. */
export function nativeCreationForDraft(creations: ReadonlyMap<string, NativeDraftCreation>, draft: NewSessionDraftState,
  runtimeKey: string): NativeDraftCreation | null {
  if (!isNativeDraftTarget(draft) || !draft.directoryOverride || !draft.selectedProjectId) return null;
  return creations.get(targetKey({ runtimeKey, draftId: draft.draftId,
    directory: draft.directoryOverride, projectId: draft.selectedProjectId })) ?? null;
}

export function publishNativeCreation(target: DraftTarget, result: NativeDraftCreation | null): void {
  useSessionUIStore.setState(state => {
    const nativeDraftCreations = new Map(state.nativeDraftCreations);
    if (result) nativeDraftCreations.set(targetKey(target), result);
    else nativeDraftCreations.delete(targetKey(target));
    return { nativeDraftCreations };
  });
}

/** A native model switch changes what an unsent created draft must send; nothing else changes. */
export function applyNativeDraftModel(created: NativeCreatedSession, model: { providerID: string; modelID: string }): void {
  useSessionUIStore.setState(state => {
    const nativeDraftCreations = new Map(state.nativeDraftCreations);
    for (const [key, record] of nativeDraftCreations) {
      if (record.status !== 'created' || record.inputAccepted || record.session !== created) continue;
      nativeDraftCreations.set(key, { ...record, session: { ...created, nativeCreation: { ...created.nativeCreation, model } } });
    }
    return { nativeDraftCreations };
  });
}

/** Starts this draft's session once. A client request id is sent only where the gateway accepts it. */
export async function prepareNativeDraft(clientRequestId?: string): Promise<void> {
  const store = useSessionUIStore.getState(), draft = store.newSessionDraft, runtimeKey = getRuntimeKey();
  assertManagedDraftTarget(draft);
  if (nativeCreationForDraft(store.nativeDraftCreations, draft, runtimeKey)) return;
  const project = visibleProjects(useProjectsStore.getState()).find(p => p.id === draft.selectedProjectId);
  if (!isNativeDraftTarget(draft) || !draft.directoryOverride || !project) throw new NativeCreationError('target');
  const pending: NativeDraftCreation = { status: 'creating', runtimeKey, draftId: draft.draftId,
    directory: draft.directoryOverride, projectId: project.id };
  publishNativeCreation(pending, pending);
  let submitted = false;
  try {
    const support = await opencodeClient.nativeCreationSupport(pending.directory);
    if (support.mode === 'legacy') throw new NativeCreationError('unsupported');
    const current = useSessionUIStore.getState();
    if (nativeCreationForDraft(current.nativeDraftCreations, current.newSessionDraft, getRuntimeKey()) !== pending) {
      throw new NativeCreationError('stale');
    }
    assertManagedDraftTarget(draft);
    submitted = true;
    const session = await createNativeSession(pending.directory, runtimeKey, support.clientRequestId ? clientRequestId : undefined);
    publishNativeCreation(pending, 'id' in session
      ? { ...pending, status: 'created', session }
      : { ...pending, status: 'pending', operation: session.nativeCreation });
    // A late result belongs to its original draft, even while another target/runtime is visible.
  } catch (cause) {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError(submitted ? 'unknown' : 'unavailable', cause);
    publishNativeCreation(pending, { ...pending, status: 'failed', error, submitted });
    throw error;
  }
}

/** Explicit read-only recovery, only after a failure known to precede session.create. */
export async function recheckNativeDraft(): Promise<boolean> {
  const store = useSessionUIStore.getState(), runtimeKey = getRuntimeKey();
  assertManagedDraftTarget(store.newSessionDraft);
  const failure = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, runtimeKey);
  if (!failure || failure.status !== 'failed' || failure.submitted) throw new NativeCreationError('required');
  publishNativeCreation(failure, { ...failure, status: 'checking' });
  try {
    const supported = await opencodeClient.supportsNativeCreation(failure.directory);
    if (getRuntimeKey() !== runtimeKey) throw new NativeCreationError('stale');
    assertManagedDraftTarget(store.newSessionDraft);
    publishNativeCreation(failure, null);
    return supported;
  } catch (cause) {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
    publishNativeCreation(failure, { ...failure, error });
    throw error;
  }
}

/** Guard the send/materialization boundary: Send starts the session first (native-draft-start); a draft without one is refused. */
export async function preparedNativeDraft(draft: NewSessionDraftState): Promise<NativeCreatedSession | null> {
  const store = useSessionUIStore.getState(), runtimeKey = getRuntimeKey();
  assertManagedDraftTarget(draft);
  const creation = nativeCreationForDraft(store.nativeDraftCreations, draft, runtimeKey);
  if (creation?.status === 'created') return creation.session;
  if (creation?.status === 'failed') throw creation.error;
  if (creation) throw new NativeCreationError('required');
  const projectDirectory = visibleProjects(useProjectsStore.getState()).find(p => p.id === draft.selectedProjectId)?.path;
  const directory = draft.directoryOverride ?? projectDirectory ?? opencodeClient.getDirectory();
  if (!directory) throw new NativeCreationError('target');
  if (await opencodeClient.supportsNativeCreation(directory)) throw new NativeCreationError('required');
  if (runtimeKey !== getRuntimeKey()) throw new NativeCreationError('stale');
  assertManagedDraftTarget(draft);
  return null;
}
