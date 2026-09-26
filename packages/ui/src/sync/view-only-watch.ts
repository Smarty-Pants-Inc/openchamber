import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * smarty-code#455 (CPU, smarty-dev#777): while a page shows a View only session, it holds that session's live tail open
 * on the gateway with one quiet event stream, `GET /api/event?directory=D&watch=S`; the gateway frees the tail as soon as
 * the stream closes. One stream per session (per server), shared by every view of it, closed when the last view closes.
 * Its frames are only a connected event and heartbeats: read and dropped (the page's own stream carries the events).
 * A gateway that does not say `readOnlyWatch: 1` in its health for that directory is not asked (it would stream
 * everything). Capability answers are per server (runtime key) and directory; a failed health read is retried.
 * Catch-up: a watch re-acquired for a session this page watched before (shown again after being hidden, or a dropped
 * stream reconnected) replaces the session's shown history with a fresh newest page once its stream is open, as on a
 * first open (its own cursor and completeness; older pages load from there). On the gateway, that read becomes the new
 * tail's baseline, so entries committed while unwatched appear, a branch changed meanwhile is shown as it is now, and
 * nothing between the read and the tail is lost.
 */
type Fetch = (input: string, init: { query: Record<string, string>; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
type Held = { views: number; stop: AbortController };
const held = new Map<string, Held>();
const supported = new Set<string>(); // `${runtime}\0${directory}` whose gateway said readOnlyWatch: 1.
let fetcher: Fetch = runtimeFetch as unknown as Fetch;
let runtime: () => string = getRuntimeKey;
type CatchUp = (sessionId: string, directory: string) => Promise<void>;
const readLatest: CatchUp = async (sessionID, directory) => { await getImperativeSessionMessageLoader()?.replaceHistory({ directory, sessionID }); };
let catchUp: CatchUp = readLatest;
const watchedBefore = new Set<string>(); // Sessions this page has watched (bounded): their next watch catches up.
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Test seams: the number of watches held, and the fetch and runtime key used. */
export const viewOnlyWatchesHeld = (): number => held.size;
export const setViewOnlyWatchDeps = (deps: { fetch?: Fetch; runtime?: () => string; catchUp?: CatchUp } = {}): void => {
  fetcher = deps.fetch ?? (runtimeFetch as unknown as Fetch); runtime = deps.runtime ?? getRuntimeKey; catchUp = deps.catchUp ?? readLatest;
  supported.clear(); watchedBefore.clear();
};

/** 'yes' or 'no' from the gateway's own health; 'unknown' when it could not be read (retried). Only 'yes' is kept. */
async function supports(key: string, directory: string, signal: AbortSignal): Promise<'yes' | 'no' | 'unknown'> {
  if (supported.has(key)) return 'yes';
  try {
    const response = await fetcher('/api/global/health', { query: { directory }, signal });
    if (!response.ok) return 'unknown';
    const body = await response.json() as { capabilities?: { readOnlyWatch?: unknown } };
    if (body?.capabilities?.readOnlyWatch !== 1) return 'no';
    supported.add(key); return 'yes';
  } catch { return 'unknown'; }
}
/** Resolves after `ms`, or at once when `signal` aborts; leaves no listener behind either way. */
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
/** One stream until it ends, fails or `signal` aborts; its frames are dropped. `opened` runs once it is open. */
async function stream(sessionId: string, directory: string, signal: AbortSignal, opened: () => void) {
  const response = await fetcher('/api/event', { query: { directory, watch: sessionId }, signal, headers: { accept: 'text/event-stream' } });
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader) { await response.body?.cancel().catch(() => {}); return; }
  opened();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try { while (!signal.aborted && !(await reader.read()).done) { /* Frames are dropped. */ } }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Holds the watch until `signal` aborts, on the server it began on: reconnects with a backoff after a failed health
 * read, a 503, an error or a closed stream; stops for good on a gateway without the capability or a server switch. */
async function hold(key: string, sessionId: string, directory: string, signal: AbortSignal) {
  const server = runtime(), session = `${key}\0${sessionId}`;
  const opened = () => { // A re-acquired watch (after a hidden spell or a drop) catches up on what it missed.
    if (watchedBefore.has(session)) void catchUp(sessionId, directory).catch(() => {});
    watchedBefore.delete(session); watchedBefore.add(session);
    if (watchedBefore.size > 256) watchedBefore.delete(watchedBefore.values().next().value!);
  };
  for (let failures = 0; !signal.aborted && runtime() === server;) {
    const answer = await supports(key, directory, signal);
    if (answer === 'no' || signal.aborted || runtime() !== server) return;
    const started = Date.now();
    if (answer === 'yes') {
      try { await stream(sessionId, directory, signal, opened); } catch { /* Aborted, or the network failed. */ }
    }
    if (signal.aborted) return;
    failures = Date.now() - started > 60_000 ? 1 : failures + 1; // A stream that lived a while starts the backoff over.
    await wait(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]!, signal);
  }
}

/** Holds the watch for one view of a session; returns its release (idempotent). */
export function holdViewOnlyWatch(sessionId: string, directory: string): () => void {
  const server = `${runtime()}\0${directory}`, key = `${server}\0${sessionId}`;
  const entry = held.get(key) ?? { views: 0, stop: new AbortController() };
  if (entry.views++ === 0) { held.set(key, entry); void hold(server, sessionId, directory, entry.stop.signal); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.views > 0) return;
    held.delete(key);
    entry.stop.abort();
  };
}

/**
 * Whether a session view is visible for its live watch: shown (active: an embedded tab's visibility handshake, the
 * desktop's main view), subscribed to its history, and not covered by a full-screen surface. messagesEnabled alone is
 * not visibility: embedded tabs keep it true while hidden (#2903). A hidden view re-watches when shown again; the
 * gateway hands the gap's entries to the new watch.
 */
export const viewOnlyWatchVisible = (view: { active: boolean; messagesEnabled: boolean; covered: boolean }): boolean =>
  view.active && view.messagesEnabled && !view.covered;

/** A visible session view (`shown`, viewOnlyWatchVisible) holds its watch while it shows a View only session. */
export function useViewOnlyWatch(sessionId: string | null | undefined, directory: string | null | undefined, readOnly: boolean, shown: boolean): void {
  React.useEffect(() => {
    if (!shown || !readOnly || !sessionId || !directory) return;
    return holdViewOnlyWatch(sessionId, directory);
  }, [directory, readOnly, sessionId, shown]);
}
