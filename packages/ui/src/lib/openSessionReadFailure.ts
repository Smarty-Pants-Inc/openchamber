/**
 * smarty-code#811 (openchamber#410 review 2): when the open session's own reads fail (its directory stream missed the
 * update and its reads answer 503: the Pi ended, or the worktree went), the page learned it only from the next managed
 * listing, 27.9 s later. A failed read of the OPEN session now asks for a fresh listing at once, so its 'ended' row
 * reaches the banner and Send within a few seconds. Other sessions' failures do not.
 * Review 3: a forced refresh supersedes the one running, so failures every 4 s with a 5 s listing never let one publish.
 * One failure-triggered refresh runs at a time; failures while it runs ask for ONE follow-up after it ends (at most one
 * start per MIN_GAP_MS either way).
 */
const MIN_GAP_MS = 3_000;
let last = -Infinity, inflight = false, followUp = false;
type Deps = { current: () => string | null | undefined; managed: () => boolean; refresh: () => Promise<void>; now?: () => number };
let deps: Deps | undefined;
/** Wired once by the page (the stores and the managed listing), so the readers need not import them. */
export function wireOpenSessionReadFailure(next: Deps | undefined): void { deps = next; last = -Infinity; inflight = false; followUp = false; }
function start(d: Deps) {
  inflight = true; last = (d.now ?? Date.now)();
  void d.refresh().catch(() => undefined).finally(() => {
    inflight = false;
    if (followUp && deps === d) { followUp = false; start(d); }
  });
}
/** A read of `sessionID` failed: refresh the managed listing when it is the open session. Returns whether one started. */
export function noteSessionReadFailed(sessionID: string): boolean {
  const d = deps;
  if (!d || d.current() !== sessionID || !d.managed()) return false;
  if (inflight) { followUp = true; return false; } // Never supersede the running sample: it would never publish.
  if ((d.now ?? Date.now)() - last < MIN_GAP_MS) return false;
  start(d);
  return true;
}
