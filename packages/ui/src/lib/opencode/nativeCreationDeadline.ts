import { NativeCreationError } from './nativeCreation';

// The server's resume handoff can take 60 seconds. Allow 75 seconds for one complete request, including its body.
export const NATIVE_CREATION_DEADLINE_MS = 75_000;

/** Only the raced result returns to the owner. Late work has no publication callback.
 * A signal may stop browser transport, never the native start. Shared loader observers ignore it. */
export function withNativeCreationDeadline<T>(work: (signal: AbortSignal) => Promise<T>,
  milliseconds = NATIVE_CREATION_DEADLINE_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const bounded = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new NativeCreationError('unknown');
      reject(error);
      controller.abort(error);
    }, milliseconds);
    void Promise.resolve().then(() => work(controller.signal)).then(resolve, reject);
  });
  return bounded.finally(() => clearTimeout(timer));
}
