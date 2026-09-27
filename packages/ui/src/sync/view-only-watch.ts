import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * smarty-code#455 (CPU, smarty-dev#777): while a page shows a View only session, it holds that session's live tail open
 * on the gateway with one quiet event stream, `GET /api/event?directory=D&watch=S`; the gateway frees the tail as soon as
 * the stream closes. One stream per session (per server), shared by every view of it, closed when the last view closes.
 * Its frames are only a connected event and heartbeats: read and dropped (the page's own stream carries the events).
 * A gateway that does not say `readOnlyWatch: 1`, `readOnlyReadBaseline: 1` and `readOnlyWatchResume: 1` in its health
 * for that directory is not asked: without the first it would stream everything; without the others a history read,
 * or a watch's release, moves its tail's baseline, and the catch-up below could keep a branch the page saw late
 * (smarty-code#507, #540). Capability answers are per server (runtime key) and directory; a failed health read is retried.
 * Catch-up: a watch re-acquired for a session this page watched before (shown again after being hidden, or a dropped
 * stream reconnected) replaces the session's shown history with a fresh newest page once its stream is open, as on a
 * first open (its own cursor and completeness; older pages load from there). On the gateway, that read becomes the new
 * tail's baseline, so entries committed while unwatched appear, a branch changed meanwhile is shown as it is now, and
 * nothing between the read and the tail is lost. An event from an older journal state than that read
 * (a stamp the gateway adds) is dropped, even one delayed past a watch the gateway could not resume (#278 review 11).
 */
type Fetch = (input: string, init: { query: Record<string, string>; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
const fetchRuntime: Fetch = (input, init) => runtimeFetch(input, init);
type Held = { views: number; stop: AbortController };
const held = new Map<string, Held>();
const supported = new Set<string>(); // `${runtime}\0${directory}` whose gateway said readOnlyWatch: 1.
let fetcher: Fetch = fetchRuntime;
let runtime: () => string = getRuntimeKey;
/** The catch-up (exported for its test). */
type CatchUp = (sessionId: string, directory: string, signal: AbortSignal, resumed: boolean) => Promise<void>;
export const readLatest: CatchUp = async (sessionID, directory, signal, resumed) => {
  // A watch the gateway did not resume (its baseline expired or was evicted) may leave an event of the old branch still on
  // its way: the replacing read below records the journal state it reflects, and the reducer drops every event from an
  // older state, whatever socket, hub or buffer delayed it (#278 review 11: event-reducer.ts journal stamps).
  if (!resumed) console.info('[view-only] the watch did not resume its tail; replacing the history');
  await getImperativeSessionMessageLoader()?.replaceHistory({ directory, sessionID }, undefined, signal); // Ends with the watch.
};
let catchUp: CatchUp = readLatest;
/** The session is enrolled now (smarty-code#616): its newest page is read at once, so the page leaves View only without
 * waiting for the session's next turn; the loader replaces the history with that first ordinary page (#497). */
type OnEnrolled = (sessionId: string, directory: string) => Promise<void>;
const ENROLLED_TAIL = 50; // The first page's size: the loader adopts that page's own cursor, and older pages load from it.
const reReadEnrolled: OnEnrolled = async (sessionID, directory) => {
  await getImperativeSessionMessageLoader()?.refreshTail({ directory, sessionID }, ENROLLED_TAIL);
};
let onEnrolled: OnEnrolled = reReadEnrolled;
const watchedBefore = new Set<string>(); // Sessions this page has watched (bounded): their next watch catches up.
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Test seams: the number of watches held, and the fetch and runtime key used. */
export const viewOnlyWatchesHeld = (): number => held.size;
export const setViewOnlyWatchDeps = (deps: { fetch?: Fetch; runtime?: () => string; catchUp?: CatchUp; onEnrolled?: OnEnrolled } = {}): void => {
  fetcher = deps.fetch ?? fetchRuntime; runtime = deps.runtime ?? getRuntimeKey; catchUp = deps.catchUp ?? readLatest;
  onEnrolled = deps.onEnrolled ?? reReadEnrolled;
  supported.clear(); watchedBefore.clear();
};

/** 'yes' or 'no' from the gateway's own health; 'unknown' when it could not be read (retried). Only 'yes' is kept. */
async function supports(key: string, directory: string, signal: AbortSignal): Promise<'yes' | 'no' | 'unknown'> {
  if (supported.has(key)) return 'yes';
  try {
    const response = await fetcher('/api/global/health', { query: { directory }, signal });
    if (!response.ok) return 'unknown';
    if (!watchCapable.safeParse(await response.json()).success) return 'no';
    supported.add(key); return 'yes';
  } catch { return 'unknown'; }
}
/** A gateway's health that says every View only watch capability. */
const watchCapable = z.object({ capabilities: z.object({
  readOnlyWatch: z.literal(1), readOnlyReadBaseline: z.literal(1), readOnlyWatchResume: z.literal(1),
}) });
/** The gateway's word on a watch: `smarty.watch {sessionID, resumed}`. */
const watchSaid = z.object({ type: z.literal('smarty.watch'), properties: z.object({ sessionID: z.string(), resumed: z.boolean() }) });
/** The gateway's word that the watched session is enrolled now (smarty-code#616): `smarty.watch {sessionID, enrolled}`. */
const watchEnrolled = z.object({ type: z.literal('smarty.watch'), properties: z.object({ sessionID: z.string(), enrolled: z.literal(true) }) });
/** Whether a frame says the watched session is enrolled now. */
const enrolledIn = (text: string, sessionId: string) => text.split('\n').some((line) => {
  if (!line.startsWith('data: ')) return false;
  let said: z.infer<typeof watchEnrolled> | undefined;
  try { said = watchEnrolled.safeParse(JSON.parse(line.slice(6))).data; } catch { /* Not an event. */ }
  return said?.properties.sessionID === sessionId;
});
/** Resolves after `ms`, or at once when `signal` aborts; leaves no listener behind either way. */
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
/** Whether a frame's smarty.watch event says the gateway resumed this watch's tail baseline (undefined: no such event). */
const resumedIn = (text: string, sessionId: string) => {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let said: z.infer<typeof watchSaid> | undefined;
    try { said = watchSaid.safeParse(JSON.parse(line.slice(6))).data; } catch { /* Not an event. */ }
    if (said?.properties.sessionID === sessionId) return said.properties.resumed;
  }
};
/** One stream until it ends, fails or `signal` aborts. `opened(resumed)` runs once it is open and the gateway said
 * whether it resumed (at most WATCH_SAID_MS: no word counts as not resumed); other frames are dropped. */
const WATCH_SAID_MS = 2_000;
async function stream(sessionId: string, directory: string, signal: AbortSignal, opened: (resumed: boolean) => void, enrolled: () => void) {
  const response = await fetcher('/api/event', { query: { directory, watch: sessionId }, signal, headers: { accept: 'text/event-stream' } });
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader || signal.aborted) { await response.body?.cancel().catch(() => {}); return; } // Released while it opened.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder(), deadline = Date.now() + WATCH_SAID_MS;
  let said: boolean | undefined, text = '';
  try {
    while (said === undefined && !signal.aborted && Date.now() < deadline) {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined; // A plain timer: an abort ends the read (cancel) anyway.
      const next = await Promise.race([reader.read(), new Promise<undefined>((resolve) => { timer = globalThis.setTimeout(() => resolve(undefined), deadline - Date.now()); })]);
      clearTimeout(timer);
      if (!next || next.done) break;
      text += decoder.decode(next.value, { stream: true }); said = resumedIn(text, sessionId); text = text.slice(-4096);
    }
    if (signal.aborted) return;
    opened(said === true);
    // Other frames are dropped; the session's enrollment is acted on (the page re-reads it as ordinary). The buffer is
    // checked at once (the handshake's own chunk may carry it, #318 review) and once more at the end of the stream.
    const check = () => { if (enrolledIn(text, sessionId)) { text = ''; enrolled(); } };
    check();
    for (;;) {
      if (signal.aborted) return;
      const next = await reader.read();
      if (next.done) { text += decoder.decode(); check(); return; }
      text = (text + decoder.decode(next.value, { stream: true })).slice(-4096);
      check();
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Holds the watch until `signal` aborts, on the server it began on: reconnects with a backoff after a failed health
 * read, a 503, an error or a closed stream; stops for good on a gateway without the capability or a server switch. */
async function hold(key: string, sessionId: string, directory: string, signal: AbortSignal) {
  const server = runtime(), session = `${key}\0${sessionId}`;
  const opened = (resumed: boolean) => { // A re-acquired watch (after a hidden spell or a drop) catches up on what it missed.
    if (watchedBefore.has(session)) void catchUp(sessionId, directory, signal, resumed).catch(() => {});
    watchedBefore.delete(session); watchedBefore.add(session);
    if (watchedBefore.size > 256) watchedBefore.delete(watchedBefore.values().next().value!);
  };
  for (let failures = 0; !signal.aborted && runtime() === server;) {
    const answer = await supports(key, directory, signal);
    if (answer === 'no' || signal.aborted || runtime() !== server) return;
    const started = Date.now();
    if (answer === 'yes') {
      try { await stream(sessionId, directory, signal, opened, () => { void onEnrolled(sessionId, directory).catch(() => {}); }); }
      catch { /* Aborted, or the network failed. */ }
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
