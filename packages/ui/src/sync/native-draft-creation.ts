import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { createNativeSession } from './session-actions';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

type DraftTarget = { runtimeKey: string; draftId: number; directory: string; projectId: string };
export type NativeDraftCreation = DraftTarget & (
  | { status: 'creating' }
  | { status: 'failed'; error: NativeCreationError }
  | { status: 'created'; session: NativeCreatedSession }
);

export function isNativeDraftTarget(draft: NewSessionDraftState): boolean {
  return draft.open && draft.target === 'project' && Boolean(draft.directoryOverride && draft.selectedProjectId)
    && !draft.parentID && !draft.title && !draft.pendingWorktreeRequestId && !draft.bootstrapPendingDirectory;
}

/** One draft/runtime/selected-project owns this in-memory result. It is never a creation journal. */
export function nativeCreationForDraft(creation: NativeDraftCreation | null, draft: NewSessionDraftState,
  runtimeKey: string): NativeDraftCreation | null {
  return creation && isNativeDraftTarget(draft) && creation.runtimeKey === runtimeKey
    && creation.draftId === draft.draftId && creation.directory === draft.directoryOverride
    && creation.projectId === draft.selectedProjectId ? creation : null;
}

export async function prepareNativeDraft(): Promise<void> {
  const store = useSessionUIStore.getState(), draft = store.newSessionDraft, runtimeKey = getRuntimeKey();
  if (nativeCreationForDraft(store.nativeDraftCreation, draft, runtimeKey)) return;
  const project = useProjectsStore.getState().projects.find(p => p.id === draft.selectedProjectId);
  if (!isNativeDraftTarget(draft) || !draft.directoryOverride || !project) {
    throw new NativeCreationError('target');
  }
  const pending: NativeDraftCreation = { status: 'creating', runtimeKey, draftId: draft.draftId,
    directory: draft.directoryOverride, projectId: project.id };
  const stillCurrent = () => nativeCreationForDraft(pending, useSessionUIStore.getState().newSessionDraft, getRuntimeKey()) !== null;
  useSessionUIStore.setState({ nativeDraftCreation: pending });
  let submitted = false;
  try {
    if (!await opencodeClient.supportsNativeCreation(pending.directory)) throw new NativeCreationError('unsupported');
    if (!stillCurrent()) throw new NativeCreationError('stale');
    submitted = true;
    const session = await createNativeSession(pending.directory, runtimeKey);
    if (!stillCurrent()) throw new NativeCreationError('stale', undefined, undefined, { id: session.id, directory: session.directory });
    useSessionUIStore.setState({ nativeDraftCreation: { ...pending, status: 'created', session } });
    // Keep text, files, mentions, synthetic context and target untouched until a later explicit Send.
  } catch (cause) {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError(submitted ? 'unknown' : 'unavailable', cause);
    if (useSessionUIStore.getState().nativeDraftCreation === pending) {
      useSessionUIStore.setState({ nativeDraftCreation: { ...pending, status: 'failed', error } });
    }
    throw error;
  }
}

/** Guard the send/materialization boundary too, not only the button. Never create from an ordinary Send. */
export async function preparedNativeDraft(draft: NewSessionDraftState): Promise<NativeCreatedSession | null> {
  const store = useSessionUIStore.getState(), runtimeKey = getRuntimeKey();
  const creation = nativeCreationForDraft(store.nativeDraftCreation, draft, runtimeKey);
  if (creation?.status === 'created') return creation.session;
  if (creation?.status === 'failed') throw creation.error;
  if (creation?.status === 'creating') throw new NativeCreationError('required');
  const projectDirectory = useProjectsStore.getState().projects.find(p => p.id === draft.selectedProjectId)?.path;
  const directory = draft.directoryOverride ?? projectDirectory ?? opencodeClient.getDirectory();
  if (!directory) throw new NativeCreationError('target');
  if (await opencodeClient.supportsNativeCreation(directory)) throw new NativeCreationError('required');
  if (runtimeKey !== getRuntimeKey()) throw new NativeCreationError('stale');
  return null;
}
