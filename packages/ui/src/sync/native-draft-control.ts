import { opencodeClient } from '@/lib/opencode/client';
import { nativeCreatedSession, NativeCreationError, type NativeCreationReply, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { assertManagedDraftTarget, nativeCreationForDraft, publishNativeCreation, type NativeDraftCreation } from './native-draft-creation';
import { indexNativeCreatedSession } from './session-actions';
import { useSessionUIStore } from './session-ui-store';

type Pending = Extract<NativeDraftCreation, { status: 'pending' }>;

function current() {
  const state = useSessionUIStore.getState(), draft = state.newSessionDraft, runtimeKey = getRuntimeKey();
  assertManagedDraftTarget(draft);
  return { draft, runtimeKey, record: nativeCreationForDraft(state.nativeDraftCreations, draft, runtimeKey) };
}

function assertCurrent(record: Pending) {
  const target = current();
  if (target.record !== record || target.runtimeKey !== record.runtimeKey) throw new NativeCreationError('stale');
}

/** A fresh list/read can recover an operation, never launch or answer a native prompt. */
export async function resumeNativeCreation(operation: NativeCreationState): Promise<void> {
  const { draft, runtimeKey, record } = current();
  if (!draft.open || !draft.selectedProjectId || draft.directoryOverride !== operation.directory
    || record && !(record.status === 'failed' && record.submitted)) throw new NativeCreationError('stale');
  const pending: Pending = { status: 'pending', runtimeKey, draftId: draft.draftId,
    projectId: draft.selectedProjectId, directory: operation.directory, operation };
  publishNativeCreation(pending, pending);
  await refreshNativeCreation();
}

async function acceptState(record: Pending, next: NativeCreationState) {
  const previous = record.operation;
  if (next.operationId !== previous.operationId || next.directory !== record.directory
    || previous.generation !== null && next.generation !== previous.generation || next.revision < previous.revision
    || previous.native && (next.native?.id !== previous.native.id || next.native?.generation !== previous.native.generation)) {
    throw new NativeCreationError('stale');
  }
  assertCurrent(record);
  if (next.phase === 'ready') {
    if (!next.native) throw new NativeCreationError('unknown');
    const detail = await opencodeClient.getSession(next.native.id, record.directory);
    assertCurrent(record);
    const ordinary = readOrdinaryModel(detail);
    if (detail.id !== next.native.id || detail.directory !== record.directory
      || !ordinary?.model || ordinary.generation !== next.native.generation) throw new NativeCreationError('stale');
    const readySession = { ...detail, nativeCreation: { model: ordinary.model, inputReady: true } };
    const session = nativeCreatedSession(readySession);
    indexNativeCreatedSession(session, record.directory, record.runtimeKey);
    publishNativeCreation(record, { runtimeKey: record.runtimeKey, draftId: record.draftId,
      projectId: record.projectId, directory: record.directory, status: 'created', session });
  } else publishNativeCreation(record, { ...record, operation: next, busy: false, error: undefined });
}

async function request(record: Pending, reply?: NativeCreationReply) {
  assertCurrent(record);
  if (record.busy) return;
  const pending = { ...record, busy: true, error: undefined };
  publishNativeCreation(record, pending);
  try {
    const next = reply
      ? await opencodeClient.replyNativeCreation(record.directory, record.operation.operationId, reply)
      : await opencodeClient.readNativeCreation(record.directory, record.operation.operationId);
    await acceptState(pending, next);
  } catch (cause) {
    // Keep the original operation after ambiguity. Re-read is allowed; replay is not.
    const state = useSessionUIStore.getState();
    if ([...state.nativeDraftCreations.values()].includes(pending)) {
      publishNativeCreation(record, { ...record, busy: false, error: cause instanceof NativeCreationError ? cause : new NativeCreationError('unknown', cause) });
    }
    throw cause;
  }
}

export async function refreshNativeCreation(): Promise<void> {
  const { record } = current();
  if (record?.status === 'pending') await request(record);
}

export async function replyNativeCreation(action: NativeCreationReply['action']): Promise<void> {
  const { record } = current();
  if (record?.status !== 'pending' || record.busy || record.error) throw new NativeCreationError('required');
  const state = record.operation;
  if (!state.generation || state.expiresAt <= Date.now()
    || (action === 'trust' || action === 'deny') && state.phase !== 'awaiting-trust'
    || action === 'ready' && (state.phase !== 'ready-required' || !state.canInitialReady || !state.native)
    || action === 'cancel' && !['awaiting-trust', 'starting', 'ready-required'].includes(state.phase)) throw new NativeCreationError('stale');
  const binding = { generation: state.generation, revision: state.revision };
  await request(record, action === 'ready'
    ? { ...binding, action, native: state.native! } : { ...binding, action });
}
