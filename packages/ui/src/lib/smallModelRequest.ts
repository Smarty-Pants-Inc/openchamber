import { toast } from '@/components/ui/toast'; // Unwrapped: this site reports its own diagnostic.
import { runtimeFetch } from '@/lib/runtime-fetch';
import { readCopy } from '@/lib/responseCopy';
import { coverFollowingToasts, reportClientError } from '@/lib/clientErrorReport';
import { getRuntimeKey } from '@/lib/runtime-switch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (runtimeKey: string, status?: number): void => {
  // Reported to the server the request went to (captured before it), with its status; the toast itself is not reported.
  reportClientError({ kind: 'small-model', status, runtimeKey });
  toast.error('Small Model unavailable', {
    id: SMALL_MODEL_TOAST_ID,
    description: 'Choose another model in Settings → Sessions → Small Model and try again.',
  });
};

export async function requestSmallModel(
  init: RequestInit,
  options: { silentStatuses?: number[] } = {},
): Promise<Response> {
  const runtimeKey = getRuntimeKey();
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (!response.ok && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable(runtimeKey, response.status);
      coverFollowingToasts(readCopy(response) ?? Promise.resolve()); // The caller's own toast for it follows once it reads the body.
    }
    return response;
  } catch (error) {
    notifySmallModelUnavailable(runtimeKey);
    coverFollowingToasts(Promise.resolve());
    throw error;
  }
}
