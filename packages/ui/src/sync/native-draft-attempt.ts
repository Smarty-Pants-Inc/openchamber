import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { forgetRequestId, notifyDraftStart, requestKey, storedRequestId } from './native-draft-intent';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

/** A reservation belongs to one press and its original project directory, never the whole page. */
export type NativeDraftAttempt = {
  draft: NewSessionDraftState; scope: ReturnType<typeof captureRuntimeRequestScope>; key: string;
  requestId?: string; ended?: 'stopped' | 'stale'; stopped: Promise<void>; stop: () => void;
};
const attempts = new Map<string, NativeDraftAttempt>();
const slot = (draft: NewSessionDraftState, runtimeKey: string) => JSON.stringify([
  runtimeKey, draft.directoryOverride ?? draft.selectedProjectId ?? null,
]);
export const draftIsStarting = (draft: NewSessionDraftState, runtimeKey: string): boolean => attempts.has(slot(draft, runtimeKey));

export function beginDraftAttempt(): NativeDraftAttempt {
  const draft = useSessionUIStore.getState().newSessionDraft, scope = captureRuntimeRequestScope();
  if (draftIsStarting(draft, scope.runtimeKey)) throw new NativeCreationError('sending');
  let stop = () => {};
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const key = requestKey(draft, scope.runtimeKey);
  const attempt = { draft, scope, key, requestId: storedRequestId(key), stopped, stop };
  attempts.set(slot(draft, scope.runtimeKey), attempt); notifyDraftStart();
  return attempt;
}

export function isDraftOriginVisible(draft: NewSessionDraftState, scope: NativeDraftAttempt['scope']): boolean {
  const now = useSessionUIStore.getState().newSessionDraft;
  return isRuntimeRequestScopeCurrent(scope) && now.draftId === draft.draftId
    && now.selectedProjectId === draft.selectedProjectId && now.directoryOverride === draft.directoryOverride;
}

export function assertDraftAttempt(attempt: NativeDraftAttempt): void {
  if (attempt.ended) throw new NativeCreationError(attempt.ended);
  if (attempts.get(slot(attempt.draft, attempt.scope.runtimeKey)) !== attempt
    || !isDraftOriginVisible(attempt.draft, attempt.scope)) {
    throw new NativeCreationError('stale');
  }
}

/** Only the press that owns a reservation can release it. Old finally blocks cannot end a newer press. */
export function endDraftAttempt(attempt: NativeDraftAttempt, reason: 'stopped' | 'stale' = 'stale'): void {
  attempt.ended ??= reason;
  if (attempts.get(slot(attempt.draft, attempt.scope.runtimeKey)) === attempt) {
    attempts.delete(slot(attempt.draft, attempt.scope.runtimeKey)); notifyDraftStart();
  }
  attempt.stop();
}

export async function waitForDraftAttempt(attempt: NativeDraftAttempt, work: Promise<void>): Promise<void> {
  await Promise.race([work, attempt.stopped.then(() => { throw new NativeCreationError(attempt.ended ?? 'stale'); })]);
  assertDraftAttempt(attempt);
}

/** Saved recovery identity is cleared only by its own request, including late errors and finally paths. */
export function forgetAttemptRequest(attempt: NativeDraftAttempt): void {
  if (attempt.requestId && storedRequestId(attempt.key) === attempt.requestId) forgetRequestId(attempt.key);
}

/** Called only after a validated cancellation and the real browser lock release. */
export function stopDraftAttempt(target: { runtimeKey: string; draftId: number; projectId: string; directory: string }, id?: string): void {
  const attempt = attempts.get(JSON.stringify([target.runtimeKey, target.directory]));
  if (!attempt || attempt.draft.draftId !== target.draftId || attempt.draft.selectedProjectId !== target.projectId
    || id !== undefined && attempt.requestId !== id) return;
  forgetAttemptRequest(attempt);
  endDraftAttempt(attempt, 'stopped');
}
