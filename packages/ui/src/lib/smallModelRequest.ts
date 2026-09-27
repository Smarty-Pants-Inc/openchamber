import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { newOperationId, reportClientError } from '@/lib/clientErrorReport';
import { getRuntimeKey } from '@/lib/runtime-switch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (scope: { runtimeKey: string; operationId: string }, status?: number): void => {
  // An operation: reported to the server it started on, once (#536).
  reportClientError({ kind: 'small-model', status, ...scope });
  toast.error('Small Model unavailable', {
    id: SMALL_MODEL_TOAST_ID,
    description: 'Choose another model in Settings → Sessions → Small Model and try again.',
  });
};

export async function requestSmallModel(
  init: RequestInit,
  options: { silentStatuses?: number[] } = {},
): Promise<Response> {
  const scope = { runtimeKey: getRuntimeKey(), operationId: newOperationId() }; // Before its first await.
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (!response.ok && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable(scope, response.status);
    }
    return response;
  } catch (error) {
    notifySmallModelUnavailable(scope);
    throw error;
  }
}
