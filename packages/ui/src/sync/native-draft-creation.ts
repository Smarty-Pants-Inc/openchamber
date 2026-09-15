import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { createNativeSession } from './session-actions';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

type DraftTarget = { runtimeKey: string; draftId: number; directory: string; projectId: string };
export type NativeDraftCreation = DraftTarget & (
  | { status: 'creating' | 'checking' }
  | { status: 'failed'; error: NativeCreationError; submitted: boolean }
  | { status: 'created'; session: NativeCreatedSession }
);

export function isNativeDraftTarget(draft: NewSessionDraftState): boolean {
  return draft.open && draft.target === 'project' && Boolean(draft.directoryOverride && draft.selectedProjectId)
    && !draft.parentID && !draft.title && !draft.pendingWorktreeRequestId && !draft.bootstrapPendingDirectory;
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

function publish(target: DraftTarget, result: NativeDraftCreation | null): void {
  useSessionUIStore.setState(state => {
    const nativeDraftCreations = new Map(state.nativeDraftCreations);
    if (result) nativeDraftCreations.set(targetKey(target), result);
    else nativeDraftCreations.delete(targetKey(target));
    return { nativeDraftCreations };
  });
}

export async function prepareNativeDraft(): Promise<void> {
  const store = useSessionUIStore.getState(), draft = store.newSessionDraft, runtimeKey = getRuntimeKey();
  if (nativeCreationForDraft(store.nativeDraftCreations, draft, runtimeKey)) return;
  const project = useProjectsStore.getState().projects.find(p => p.id === draft.selectedProjectId);
  if (!isNativeDraftTarget(draft) || !draft.directoryOverride || !project) throw new NativeCreationError('target');
  const pending: NativeDraftCreation = { status: 'creating', runtimeKey, draftId: draft.draftId,
    directory: draft.directoryOverride, projectId: project.id };
  publish(pending, pending);
  let submitted = false;
  try {
    if (!await opencodeClient.supportsNativeCreation(pending.directory)) throw new NativeCreationError('unsupported');
    const current = useSessionUIStore.getState();
    if (nativeCreationForDraft(current.nativeDraftCreations, current.newSessionDraft, getRuntimeKey()) !== pending) {
      throw new NativeCreationError('stale');
    }
    submitted = true;
    const session = await createNativeSession(pending.directory, runtimeKey);
    publish(pending, { ...pending, status: 'created', session });
    // A late result belongs to its original draft, even while another target/runtime is visible.
  } catch (cause) {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError(submitted ? 'unknown' : 'unavailable', cause);
    publish(pending, { ...pending, status: 'failed', error, submitted });
    throw error;
  }
}

/** Explicit read-only recovery, only after a failure known to precede session.create. */
export async function recheckNativeDraft(): Promise<boolean> {
  const store = useSessionUIStore.getState(), runtimeKey = getRuntimeKey();
  const failure = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, runtimeKey);
  if (!failure || failure.status !== 'failed' || failure.submitted) throw new NativeCreationError('required');
  publish(failure, { ...failure, status: 'checking' });
  try {
    const supported = await opencodeClient.supportsNativeCreation(failure.directory);
    if (getRuntimeKey() !== runtimeKey) throw new NativeCreationError('stale');
    publish(failure, null);
    return supported;
  } catch (cause) {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
    publish(failure, { ...failure, error });
    throw error;
  }
}

/** Guard the send/materialization boundary too, not only the button. Never create from an ordinary Send. */
export async function preparedNativeDraft(draft: NewSessionDraftState): Promise<NativeCreatedSession | null> {
  const store = useSessionUIStore.getState(), runtimeKey = getRuntimeKey();
  const creation = nativeCreationForDraft(store.nativeDraftCreations, draft, runtimeKey);
  if (creation?.status === 'created') return creation.session;
  if (creation?.status === 'failed') throw creation.error;
  if (creation) throw new NativeCreationError('required');
  const projectDirectory = useProjectsStore.getState().projects.find(p => p.id === draft.selectedProjectId)?.path;
  const directory = draft.directoryOverride ?? projectDirectory ?? opencodeClient.getDirectory();
  if (!directory) throw new NativeCreationError('target');
  if (await opencodeClient.supportsNativeCreation(directory)) throw new NativeCreationError('required');
  if (runtimeKey !== getRuntimeKey()) throw new NativeCreationError('stale');
  return null;
}
