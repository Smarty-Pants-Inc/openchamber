// openchamber#574 security review: a tab brought back (shown again, or restored from the back-forward cache) may now belong
// to another signed-in person (an account switch in another tab changes the shared cookie, not this page's memory). Each
// return bumps `restoreEpoch`; whatever another person's data this page holds is hidden in that same render and read again
// under the current cookie, which the gateway authorizes (a 403 keeps it hidden).
import React from 'react';

let epoch = 0;
const listeners = new Set<() => void>();
const bump = () => { epoch += 1; for (const listener of listeners) listener(); };
const onVisibility = () => { if (document.visibilityState === 'visible') bump(); };
const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) bump(); };

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow as EventListener);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow as EventListener);
    }
  };
}

/** How many times this page was brought back while a reader was mounted (see above). */
export function useRestoreEpoch(): number {
  return React.useSyncExternalStore(subscribe, () => epoch, () => 0);
}
