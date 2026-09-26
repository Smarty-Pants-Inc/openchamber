import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * smarty-code#455 (CPU, smarty-dev#777): while a page shows a View only session, it holds that session's live tail open
 * on the gateway with one quiet event stream, `GET /api/event?directory=D&watch=S`; the gateway frees the tail as soon as
 * the stream closes. One stream per session, shared by every view of it, closed when the last view closes. Its frames
 * are only a connected event and heartbeats: read and dropped (the page's own event stream carries the session's events).
 * A gateway that does not say `readOnlyWatch: 1` in its health is not asked (it would stream everything).
 */
type Fetch = (input: string, init: { query: Record<string, string>; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
type Held = { views: number; stop: AbortController };
const held = new Map<string, Held>();
const support = new Map<string, Promise<boolean>>();
let fetcher: Fetch = runtimeFetch as unknown as Fetch;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Test seams: the number of sessions whose watch is held, and the fetch used. */
export const viewOnlyWatchesHeld = (): number => held.size;
export const setViewOnlyWatchFetch = (next?: Fetch): void => { fetcher = next ?? (runtimeFetch as unknown as Fetch); support.clear(); };

const supports = (directory: string): Promise<boolean> => {
  const known = support.get(directory);
  if (known) return known;
  const asked = fetcher('/api/global/health', { query: { directory } })
    .then(async (response) => response.ok && (await response.json() as { capabilities?: { readOnlyWatch?: unknown } })?.capabilities?.readOnlyWatch === 1)
    .catch(() => false);
  support.set(directory, asked);
  void asked.then((yes) => { if (!yes) support.delete(directory); }); // Asked again next time: a gateway may be upgraded.
  return asked;
};
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Holds the stream until `signal` aborts: reconnects after a 503 (catalog briefly unavailable) or a closed stream. */
async function hold(sessionId: string, directory: string, signal: AbortSignal) {
  if (!await supports(directory)) return;
  for (let failures = 0; !signal.aborted;) {
    const started = Date.now();
    try {
      const response = await fetcher('/api/event', { query: { directory, watch: sessionId }, signal, headers: { accept: 'text/event-stream' } });
      const reader = response.ok ? response.body?.getReader() : undefined;
      if (reader) {
        signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
        while (!signal.aborted && !(await reader.read()).done) { /* Frames are dropped. */ }
      } else await response.body?.cancel().catch(() => {});
    } catch { /* Aborted, or the network failed: retried below unless aborted. */ }
    if (signal.aborted) return;
    failures = Date.now() - started > 60_000 ? 0 : failures + 1; // A stream that lived a while starts the backoff over.
    await wait(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 0, signal);
  }
}

/** Holds the watch for one view of a session; returns its release (idempotent). */
export function holdViewOnlyWatch(sessionId: string, directory: string): () => void {
  const key = `${directory}\0${sessionId}`;
  const entry = held.get(key) ?? { views: 0, stop: new AbortController() };
  if (entry.views++ === 0) { held.set(key, entry); void hold(sessionId, directory, entry.stop.signal); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.views > 0) return;
    held.delete(key);
    entry.stop.abort();
  };
}

/** A session view holds its watch while it shows a View only session. */
export function useViewOnlyWatch(sessionId: string | null | undefined, directory: string | null | undefined, readOnly: boolean): void {
  React.useEffect(() => {
    if (!readOnly || !sessionId || !directory) return;
    return holdViewOnlyWatch(sessionId, directory);
  }, [directory, readOnly, sessionId]);
}
