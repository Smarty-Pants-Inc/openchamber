import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, nativeCreationFailure, NATIVE_CREATION_INVALIDATED, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, getRuntimeKey, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { publishNativeCreation, type NativeDraftCreation } from './native-draft-creation';
import { stopDraftAttempt } from './native-draft-attempt';
import { clearSentStart, releaseSentStart, sentStartRequest } from './native-draft-sent';
import { useSessionUIStore } from './session-ui-store';

/** Actual cancellation receipts, scoped to their original runtime and directory. Never a page-wide success flag. */
export const abandonedNativeCreations = new Map<string, { runtimeKey: string; operation: NativeCreationState }>();
export const wasNativeCreationAbandoned = (runtimeKey: string, operation: NativeCreationState): boolean => {
  const stopped = abandonedNativeCreations.get(operation.operationId);
  return stopped?.runtimeKey === runtimeKey && stopped.operation.directory === operation.directory
    && stopped.operation.clientRequestId === operation.clientRequestId;
};

export const STOP_START_GRACE_MS = 60_000;
const firstSeen = new Map<string, number>();
/** At once past expiry, otherwise after this runtime first saw the exact operation. */
export function stoppableAt(operation: NativeCreationState, now = Date.now()): number {
  const key = JSON.stringify([getRuntimeKey(), operation.directory, operation.operationId, operation.clientRequestId]);
  const seen = firstSeen.get(key) ?? (firstSeen.set(key, now), now);
  return operation.expiresAt <= now ? now : Math.min(seen + STOP_START_GRACE_MS, operation.expiresAt);
}

function ownsOperation(record: NativeDraftCreation, runtimeKey: string, operation: NativeCreationState): boolean {
  if (record.runtimeKey !== runtimeKey || record.directory !== operation.directory) return false;
  if (record.status === 'pending') return record.operation.operationId === operation.operationId
    && record.operation.clientRequestId === operation.clientRequestId;
  return (record.status === 'creating' || record.status === 'failed' && record.submitted)
    && record.submitted === true && operation.clientRequestId !== undefined && record.clientRequestId === operation.clientRequestId;
}

/** A held POST has no operation receipt yet. Only one exact match from the scoped fresh listing can supply Stop. */
export function matchingOwnNativeCreation(record: NativeDraftCreation | null, operations: readonly NativeCreationState[], runtimeKey: string): NativeCreationState | undefined {
  if (!record || record.status !== 'creating' && !(record.status === 'failed' && record.submitted)) return undefined;
  const matches = operations.filter(operation => ownsOperation(record, runtimeKey, operation)
    && !['ready', 'denied', 'cancelled', 'expired'].includes(operation.phase));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Stop is final only when the gateway returns cancelled for the exact original operation and request. */
export async function stopBlockingStart(operation: NativeCreationState, scope: RuntimeRequestScope = captureRuntimeRequestScope()): Promise<void> {
  if (!isRuntimeRequestScopeCurrent(scope)) throw new NativeCreationError('stale');
  const origin = [...useSessionUIStore.getState().nativeDraftCreations.values()].find(record => ownsOperation(record, scope.runtimeKey, operation));
  let next: NativeCreationState;
  try { next = await opencodeClient.abandonNativeCreation(operation.directory, operation.operationId); }
  catch (cause) { throw cause instanceof NativeCreationError ? cause : nativeCreationFailure(cause); }
  if (!isRuntimeRequestScopeCurrent(scope)) throw new NativeCreationError('stale');
  if (next.operationId !== operation.operationId || next.directory !== operation.directory || next.phase !== 'cancelled'
    || next.clientRequestId !== operation.clientRequestId) throw new NativeCreationError('unknown');
  // Await the actual Web Lock request, not just its release callback, before returning input or admitting another press.
  const ownedRequest = origin || sentStartRequest(scope.runtimeKey, operation.directory) === operation.clientRequestId
    ? operation.clientRequestId : undefined;
  await releaseSentStart(ownedRequest);
  if (!isRuntimeRequestScopeCurrent(scope)) throw new NativeCreationError('stale');
  abandonedNativeCreations.set(next.operationId, { runtimeKey: scope.runtimeKey, operation: next });
  if (origin) {
    const retained = [...useSessionUIStore.getState().nativeDraftCreations.values()].find(record =>
      record.draftId === origin.draftId && record.projectId === origin.projectId && ownsOperation(record, scope.runtimeKey, operation));
    if (retained) {
      publishNativeCreation(retained, { ...retained, status: 'pending', operation: next, busy: false,
        error: undefined, unreadable: undefined }, retained);
      // The own live editor may not have flushed any saved text yet. Cancelled proves this exact mark is unsent.
      clearSentStart(scope.runtimeKey, retained.directory, operation.clientRequestId);
      stopDraftAttempt(retained, retained.clientRequestId ?? operation.clientRequestId);
    }
  }
  globalThis.window?.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED, { detail: { runtimeKey: scope.runtimeKey, directory: operation.directory } }));
}
