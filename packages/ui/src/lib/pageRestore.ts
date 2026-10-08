// openchamber#574 security review: a tab brought back (shown again, or restored from the back-forward cache) may now belong
// to another signed-in person (an account switch in another tab changes the shared cookie, not this page's memory). Each
// return bumps `restoreEpoch`; whatever another person's data this page holds is hidden in that same render and read again
// under the current cookie, which the gateway authorizes (a 403 keeps it hidden).
import React from 'react';

let epoch = 0;
const listeners = new Set<() => void>();
/** The page was brought back: every reader of another person's possible data starts over. Exported for tests. */
export const noteRestore = () => { epoch += 1; for (const listener of [...listeners]) listener(); };
const onVisibility = () => { if (document.visibilityState === 'visible') noteRestore(); };
const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) noteRestore(); };
const dom = () => typeof document !== 'undefined' && typeof window !== 'undefined';

/** Calls `listener` each time the page is brought back (also the hook's subscription). */
export function subscribeRestore(listener: () => void): () => void {
  if (listeners.size === 0 && dom()) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow as EventListener);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && dom()) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow as EventListener);
    }
  };
}

/** How many times this page was brought back while a reader was mounted (see above). */
export function useRestoreEpoch(): number {
  return React.useSyncExternalStore(subscribeRestore, () => epoch, () => 0);
}
