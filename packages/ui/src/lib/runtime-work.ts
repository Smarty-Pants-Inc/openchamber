/**
 * Work the page still has out on each server, kept by runtimeFetch (smarty-code#536). An error shown right after a
 * previous server's request settles may be that server's; the client-error reporter does not report such an error to
 * the page's current server. Only counts and one time: no network, no content.
 */
const pending = new Map<string, number>();
let previousSettledAt = Number.NEGATIVE_INFINITY;
const SETTLE_WINDOW_MS = 2_000; // A failure is shown within moments of its request settling.

export function beginRuntimeWork(runtimeKey: string): () => void {
  pending.set(runtimeKey, (pending.get(runtimeKey) ?? 0) + 1);
  return () => {
    const left = (pending.get(runtimeKey) ?? 1) - 1;
    if (left > 0) pending.set(runtimeKey, left); else pending.delete(runtimeKey);
  };
}

/** A request settled after its server stopped being the page's. */
export function notePreviousRuntimeSettled(now = Date.now()): void { previousSettledAt = now; }

/** True while another server's work is still out, or has just settled. */
export function previousRuntimeWorkInDoubt(currentRuntimeKey: string | undefined, now = Date.now()): boolean {
  for (const [key, count] of pending) if (key !== currentRuntimeKey && count > 0) return true;
  return now - previousSettledAt < SETTLE_WINDOW_MS;
}

/** Tests model a page load. */
export function resetRuntimeWorkForPage(): void { pending.clear(); previousSettledAt = Number.NEGATIVE_INFINITY; }
