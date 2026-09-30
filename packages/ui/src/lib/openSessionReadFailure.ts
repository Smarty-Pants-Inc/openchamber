/**
 * smarty-code#811 (openchamber#410 review 2): when the open session's own reads fail (its directory stream missed the
 * update and its reads answer 503: the Pi ended, or the worktree went), the page learned it only from the next managed
 * listing, 27.9 s later. A failed read of the OPEN session now asks for a fresh listing at once, so its 'ended' row
 * reaches the banner and Send within a few seconds. Other sessions' failures do not.
 * Review 3: a forced refresh supersedes the one running, so failures every 4 s with a 5 s listing never let one publish.
 * One failure-triggered refresh runs at a time; failures while it runs ask for ONE follow-up after it ends (at most one
 * start per MIN_GAP_MS either way).
 * Review 4: busy lasts until the catalog sample really ends (not its caller's 30 s wait), and queued starts keep the gap.
 */
const MIN_GAP_MS = 3_000;
let last = -Infinity, inflight = false, followUp = false, timer: ReturnType<typeof setTimeout> | undefined;
/** `sample`: the catalog sample running now (any caller's) and when it really ends, which can be after `refresh`
 * settles (a slow sample keeps running past its caller's 30 s wait; managed-project-refresh.ts). */
type Deps = { current: () => string | null | undefined; managed: () => boolean; refresh: () => Promise<void>; now?: () => number;
  sample?: () => Promise<void> | undefined };
let deps: Deps | undefined;
/** Wired once by the page (the stores and the managed listing), so the readers need not import them. */
export function wireOpenSessionReadFailure(next: Deps | undefined): void {
  clearTimeout(timer); timer = undefined; deps = next; last = -Infinity; inflight = false; followUp = false;
}
const quiet = (p: Promise<void> | undefined) => Promise.resolve(p).catch(() => undefined);
/** Busy until `until` ends AND the catalog sample it left running ends (review 4: a slow sample outlives its caller, and a
 * follow-up started at the caller's settle superseded it, so a successful 35 s sample never published). */
function busyUntil(d: Deps, until: Promise<void> | undefined) {
  inflight = true;
  void quiet(until).then(() => quiet(d.sample?.())).finally(() => {
    inflight = false;
    if (followUp && deps === d) { followUp = false; later(d); }
  });
}
function start(d: Deps) { last = (d.now ?? Date.now)(); busyUntil(d, d.refresh()); }
/** The one follow-up keeps the minimum gap too (review 4: a queued start ran at once after a 1 s sample). */
function later(d: Deps) {
  const wait = MIN_GAP_MS - ((d.now ?? Date.now)() - last);
  if (wait <= 0) { start(d); return; }
  inflight = true; // Holds the slot: failures meanwhile add nothing.
  timer = setTimeout(() => { timer = undefined; inflight = false; if (deps === d) start(d); }, wait);
}
/** A read of `sessionID` failed: refresh the managed listing when it is the open session. Returns whether one started. */
export function noteSessionReadFailed(sessionID: string): boolean {
  const d = deps;
  if (!d || d.current() !== sessionID || !d.managed()) return false;
  if (inflight) { followUp = true; return false; } // Never supersede the running sample: it would never publish.
  // Another caller's sample is running: wait for its end, then one follow-up (never supersede it either).
  const running = d.sample?.();
  if (running) { followUp = true; busyUntil(d, running); return false; }
  if ((d.now ?? Date.now)() - last < MIN_GAP_MS) return false;
  start(d);
  return true;
}
