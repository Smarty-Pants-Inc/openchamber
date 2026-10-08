// smarty-code#1476: another principal's inbox, read only. It shows only once the gateway has shared it (its Open list
// answered for that person); a 403 (not shared), a 401 or a 404 leaves it hidden: no button, no error, no retry. A
// transient failure (network, 5xx, 429) retries 2 s, 5 s, 15 s, then every 30 s while the page is visible. Each event on
// its stream reads the Open list again and bumps `revision`, so the open tab reloads too.
// Review P1: what is shown belongs to one viewer. A verified recovery (another person signed in on this origin) bumps
// `recoveryGeneration` and retires the old request scope: the old viewer's inbox goes at once, their in-flight answers
// are dropped, and nothing shows until the new viewer's own read succeeds.
// Security review (round 2): a tab brought back (`useRestoreEpoch`) may now be another person's: the inbox hides in that
// render and is read again under the current cookie; only the gateway's answer to that read shows it.
import React from 'react';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { isTransientInboxFailure, loadInbox } from '@/lib/smartyInbox';
import { useRestoreEpoch } from '@/lib/pageRestore';

export type SharedInbox = { state: 'hidden' } | { state: 'shown'; openCount: number; revision: number };
type Held = { state: 'hidden' } | { state: 'shown'; openCount: number; revision: number; person: string; generation: number; restored: number };
const HIDDEN = { state: 'hidden' } satisfies SharedInbox;
const SHARED_INBOX_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export function useSharedInbox(person: string | null, watch: (person: string, onChange: () => void) => () => void): SharedInbox {
  const generation = useAuthSessionStore(state => state.recoveryGeneration), restored = useRestoreEpoch();
  const [held, setHeld] = React.useState<Held>(HIDDEN);
  React.useEffect(() => {
    if (person === null) return undefined;
    const scope = captureRuntimeRequestScope();
    let current = true, latest = 0, failures = 0;
    let close: (() => void) | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const live = (request: number) => current && request === latest && isRuntimeRequestScopeCurrent(scope);
    // A hidden page waits: bringing it back re-runs this effect, which reads at once.
    const retry = () => { if (document.visibilityState !== 'hidden') read(); };
    const read = () => {
      clearTimeout(timer);
      const request = ++latest;
      loadInbox('open', undefined, person).then(result => {
        if (!live(request)) return;
        failures = 0;
        if (!result.available) { setHeld(HIDDEN); return; }
        setHeld(before => ({ state: 'shown', person, generation, restored, openCount: result.items.length, revision: before.state === 'shown' ? before.revision + 1 : 0 }));
        close ??= watch(person, read);
      }, error => {
        if (!live(request)) return;
        if (!isTransientInboxFailure(error)) { setHeld(HIDDEN); return; }
        timer = setTimeout(retry, SHARED_INBOX_RETRY_MS[Math.min(failures++, SHARED_INBOX_RETRY_MS.length - 1)]);
      });
    };
    read();
    return () => { current = false; clearTimeout(timer); close?.(); setHeld(HIDDEN); };
  }, [person, watch, generation, restored]);
  // Checked while rendering, so the old viewer's inbox is gone in the same paint as the change, before any effect runs.
  return held.state === 'shown' && held.person === person && held.generation === generation && held.restored === restored ? held : HIDDEN;
}
