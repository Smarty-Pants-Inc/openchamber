import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreationResult } from '@/lib/opencode/nativeCreation';
import { isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { indexNativeCreatedSession } from './session-actions';
import { useSessionUIStore } from './session-ui-store';
import { isRetainedNativeCreation, publishNativeCreation, type NativeDraftCreation } from './native-draft-creation';

/** A create POST may still finish remotely after this local wait. The request identity remains recoverable. */
const CREATE_WAIT_MS = 120_000;
export async function waitForNativeDraftCreate(origin: NativeDraftCreation, clientRequestId: string | undefined, scope: RuntimeRequestScope): Promise<void> {
  if (!isRuntimeRequestScopeCurrent(scope) || scope.runtimeKey !== origin.runtimeKey) {
    const error = new NativeCreationError('stale');
    publishNativeCreation(origin, { ...origin, status: 'failed', submitted: false, error }, origin);
    throw error;
  }
  let retained = origin, waiting = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = (result: NativeCreationResult) => {
    if (!isRetainedNativeCreation(retained)) return;
    const directory = 'id' in result ? result.directory : result.nativeCreation.directory;
    if (directory !== origin.directory || !('id' in result) && clientRequestId
      && result.nativeCreation.clientRequestId !== clientRequestId) throw new NativeCreationError('unknown');
    // Retain a late result, but never index, select, answer or send it after the wait or runtime scope ends.
    if ('id' in result && waiting && isRuntimeRequestScopeCurrent(scope)) indexNativeCreatedSession(result, origin.directory, origin.runtimeKey);
    const next: NativeDraftCreation = 'id' in result ? { ...origin, status: 'created', session: result }
      : { ...origin, status: 'pending', operation: result.nativeCreation };
    const previous = retained; retained = next;
    publishNativeCreation(origin, next, previous);
  };
  const fail = (cause: unknown) => {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unknown', cause);
    const failed: NativeDraftCreation = { ...origin, status: 'failed', submitted: true, error };
    const previous = retained; retained = failed;
    publishNativeCreation(origin, failed, previous);
    throw error;
  };
  let unsubscribe = () => {};
  const superseded = new Promise<never>((_, reject) => {
    unsubscribe = useSessionUIStore.subscribe(() => {
      if (!isRetainedNativeCreation(retained)) reject(new NativeCreationError('stale'));
    });
  });
  const receipt = opencodeClient.createNativeSession(origin.directory, clientRequestId).then(accept).catch(fail);
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      waiting = false;
      const error = new NativeCreationError('unknown');
      const failed: NativeDraftCreation = { ...origin, status: 'failed', submitted: true, error };
      const previous = retained; retained = failed;
      publishNativeCreation(origin, failed, previous);
      reject(error);
    }, CREATE_WAIT_MS);
  });
  try { await Promise.race([receipt, limit, superseded]); }
  finally { waiting = false; clearTimeout(timer); unsubscribe(); }
}
