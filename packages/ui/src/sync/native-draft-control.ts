import { opencodeClient } from '@/lib/opencode/client';
import { nativeCreatedSession, nativeCreationFailure, NativeCreationError, type NativeCreationReply, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { assertManagedDraftTarget, nativeCreationForDraft, publishNativeCreation, type NativeDraftCreation } from './native-draft-creation';
import { indexNativeCreatedSession } from './session-actions';
import { useSessionUIStore } from './session-ui-store';

type Pending = Extract<NativeDraftCreation, { status: 'pending' }>;

/** Operations this page abandoned (#340): settled for good, even in a list read before that. */
export const abandonedNativeCreations = new Set<string>();

/**
 * 'ready' is answered once per operation (F11), also across a reload of this tab: sessionStorage, keyed by the
 * operation and its generation.
 */
const readyKey = (operation: NativeCreationState) => `oc.nativeCreation.ready:${JSON.stringify([operation.operationId, operation.generation])}`;
const readyReplied = (operation: NativeCreationState) => { try { return sessionStorage.getItem(readyKey(operation)) !== null; } catch { return false; } };
function markReadyReplied(operation: NativeCreationState, replied: boolean) {
  try { if (replied) sessionStorage.setItem(readyKey(operation), '1'); else sessionStorage.removeItem(readyKey(operation)); }
  catch { /* no storage: this page still keeps it on the record */ }
}

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
  if (readyReplied(operation)) pending.readyReplied = true;
  publishNativeCreation(pending, pending);
  await refreshNativeCreation();
}

async function acceptState(record: Pending, next: NativeCreationState) {
  const previous = record.operation;
  // A stopped operation is final whatever generation it reports (an abandoned one reports none, #340): accept it.
  if (['denied', 'cancelled', 'expired'].includes(next.phase) && next.operationId === previous.operationId
    && next.directory === record.directory) {
    assertCurrent(record);
    publishNativeCreation(record, { ...record, operation: next, busy: false, error: undefined, unreadable: undefined });
    return;
  }
  // 'unavailable' is no new state: the gateway could not read the new owner this time and the operation is unsettled
  // (smarty-code#126, 3.18 walk). Keep the last known state, and only re-read until a real one arrives.
  if (next.phase === 'unavailable' && next.operationId === previous.operationId && next.directory === record.directory) {
    assertCurrent(record);
    publishNativeCreation(record, { ...record, busy: false, error: undefined, unreadable: true });
    return;
  }
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
      projectId: record.projectId, directory: record.directory, status: 'created', session, clientRequestId: record.operation.clientRequestId });
  } else {
    // A state no newer than one this record already answered does not show the reply's outcome: re-read, never replay.
    const stale = record.answered !== undefined && next.revision <= record.answered;
    // Its ready answer may be known only under the real generation (a reload that first listed it unavailable).
    publishNativeCreation(record, { ...record, operation: next, busy: false, error: undefined, unreadable: stale || undefined,
      readyReplied: record.readyReplied || readyReplied(next) || undefined });
  }
}

async function request(record: Pending, reply?: NativeCreationReply) {
  assertCurrent(record);
  if (record.busy) return;
  const pending: Pending = { ...record, busy: true, error: undefined };
  if (reply) pending.answered = record.operation.revision;
  if (reply?.action === 'ready') { pending.readyReplied = true; markReadyReplied(record.operation, true); }
  publishNativeCreation(record, pending);
  try {
    const next = reply
      ? await opencodeClient.replyNativeCreation(record.directory, record.operation.operationId, reply)
      : await opencodeClient.readNativeCreation(record.directory, record.operation.operationId);
    await acceptState(pending, next);
  } catch (cause) {
    // Keep the original operation after ambiguity. Re-read is allowed; replay is not.
    const state = useSessionUIStore.getState();
    // A ready answer the server definitely refused (it answered 409 and armed nothing) may be answered again after a
    // re-read; an uncertain one never is.
    const refused = reply?.action === 'ready' && cause instanceof NativeCreationError && cause.status === 409;
    if (refused) markReadyReplied(record.operation, false);
    if ([...state.nativeDraftCreations.values()].includes(pending)) {
      publishNativeCreation(pending, { ...pending, busy: false, readyReplied: refused ? undefined : pending.readyReplied,
        answered: refused ? record.answered : pending.answered,
        error: cause instanceof NativeCreationError ? cause : new NativeCreationError('unknown', cause) });
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
  if (record?.status !== 'pending' || record.busy || record.error || record.unreadable
    || action === 'ready' && record.readyReplied) throw new NativeCreationError('required');
  const state = record.operation;
  if (!state.generation || state.expiresAt <= Date.now()
    || (action === 'trust' || action === 'deny') && state.phase !== 'awaiting-trust'
    || action === 'ready' && (state.phase !== 'ready-required' || !state.canInitialReady || !state.native)
    || action === 'cancel' && !['awaiting-trust', 'starting', 'ready-required'].includes(state.phase)) throw new NativeCreationError('stale');
  const binding = { generation: state.generation, revision: state.revision };
  await request(record, action === 'ready'
    ? { ...binding, action, native: state.native! } : { ...binding, action });
}

/** Leave this draft's unreadable start behind (smarty-code#340): the server settles it cancelled for good; the record is
 * dropped only after that, so a refused abandon keeps the start as it was. */
export async function abandonNativeCreation(): Promise<boolean> {
  const { record } = current();
  if (record?.status !== 'pending' || record.busy || !(record.unreadable || record.operation.phase === 'unavailable')) return false;
  const pending: Pending = { ...record, busy: true };
  publishNativeCreation(record, pending);
  try {
    const next = await opencodeClient.abandonNativeCreation(record.directory, record.operation.operationId);
    if (next.operationId !== record.operation.operationId || next.phase !== 'cancelled') throw new NativeCreationError('unknown');
    abandonedNativeCreations.add(next.operationId);
    publishNativeCreation(pending, null);
    return true;
  } catch (cause) {
    publishNativeCreation(pending, { ...record, busy: false });
    throw cause instanceof NativeCreationError ? cause : nativeCreationFailure(cause);
  }
}
