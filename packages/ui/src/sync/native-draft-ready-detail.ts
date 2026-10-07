import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
const httpFailure = z.object({ status: z.number().optional() });

/** Bound the whole Ready detail load, including an in-flight SDK GET and backoff. The SDK owns transport timeout;
 * a local deadline stops waiting, not the remote GET. No late result can publish outside the caller's acceptance. */
async function beforeDeadline<T>(work: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new NativeCreationError('history');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NativeCreationError('history')), remaining);
  });
  try { return await Promise.race([work(), expired]); }
  finally { clearTimeout(timer); }
}

/** Ready is creation authority, not a loaded session or an accepted history view. Only reads are retried (#931). */
export async function readReadySession(id: string, directory: string, deadline: number, assertCurrent: () => void) {
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const detail = await beforeDeadline(() => {
        assertCurrent(); // At actual dispatch, including retries, before the SDK can resolve a new runtime scope.
        return opencodeClient.getSession(id, directory);
      }, deadline);
      assertCurrent();
      return detail;
    } catch (cause) {
      assertCurrent();
      if (cause instanceof NativeCreationError) throw cause;
      const status = httpFailure.safeParse(cause).data?.status;
      const definite = status !== undefined && status < 500 && status !== 408 && status !== 429;
      if (definite || attempt >= BACKOFF_MS.length || Date.now() >= deadline) throw new NativeCreationError('history', cause);
      await beforeDeadline(() => new Promise<void>(done => setTimeout(done, BACKOFF_MS[attempt])), deadline);
    }
  }
}
