/**
 * smarty-code#811 (openchamber#410 review 2): when the open session's own reads fail (its directory stream missed the
 * update and its reads answer 503: the Pi ended, or the worktree went), the page learned it only from the next managed
 * listing, 27.9 s later. A failed read of the OPEN session now asks for a fresh listing at once (at most one per
 * MIN_GAP_MS), so its 'ended' row reaches the banner and Send within a few seconds. Other sessions' failures do not.
 */
const MIN_GAP_MS = 3_000;
let last = -Infinity;
type Deps = { current: () => string | null | undefined; managed: () => boolean; refresh: () => Promise<void>; now?: () => number };
let deps: Deps | undefined;
/** Wired once by the page (the stores and the managed listing), so the readers need not import them. */
export function wireOpenSessionReadFailure(next: Deps | undefined): void { deps = next; last = -Infinity; }
/** A read of `sessionID` failed: refresh the managed listing when it is the open session. Returns whether it did. */
export function noteSessionReadFailed(sessionID: string): boolean {
  if (!deps || deps.current() !== sessionID || !deps.managed()) return false;
  const now = (deps.now ?? Date.now)();
  if (now - last < MIN_GAP_MS) return false;
  last = now;
  void deps.refresh().catch(() => undefined);
  return true;
}
