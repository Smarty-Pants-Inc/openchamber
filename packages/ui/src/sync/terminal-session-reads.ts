import { getRuntimeKey } from "@/lib/runtime-switch"

/**
 * Reconnect resync reads every active session's detail and tail. A session the server answers with a
 * terminal status (not found here, not enrolled, gone) will answer the same on the next reconnect or
 * watchdog pass; asking again every few seconds flooded the browser's connections (sidebar audit
 * 2026-09-24: ~15 failed reads/s) and delayed catalog refreshes and sends. Such a session is skipped
 * for a bounded time; opening it still reads it (only the background resync consults this).
 */
export const TERMINAL_SESSION_READ_BACKOFF_MS = 60_000
const TERMINAL_STATUSES = new Set([404, 409, 410])
const suppressedUntil = new Map<string, number>()
// smarty-code#1575: the open session's 404 ("Unknown Pi session in requested project") makes it gone, with no expiry, until
// a 200 or a managed listing names it again. Gone wins over the back-off; other sessions keep only the 60 s back-off.
const gone = new Set<string>()
// Bumped each time a listing names the session: a 404 whose read started before that listing is stale.
const listedGeneration = new Map<string, number>()

const keyFor = (directory: string, sessionID: string, runtimeKey = getRuntimeKey()) =>
  JSON.stringify([runtimeKey, directory, sessionID])

/** Pass the runtime key captured when the read started, so a late answer never marks another runtime. */
export function recordSessionReadFailure(directory: string, sessionID: string, error: unknown,
  runtimeKey = getRuntimeKey(), now = Date.now()): void {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === "number" && TERMINAL_STATUSES.has(status)) {
    suppressedUntil.set(keyFor(directory, sessionID, runtimeKey), now + TERMINAL_SESSION_READ_BACKOFF_MS)
  }
}

/** A successful read (for example after enrollment) makes the session readable again at once. */
export function clearSessionReadFailure(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): void {
  suppressedUntil.delete(keyFor(directory, sessionID, runtimeKey))
  gone.delete(keyFor(directory, sessionID, runtimeKey))
}

/** A managed listing named the session again: no longer gone, and any 404 read already in flight no longer applies. */
export function clearSessionGone(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): void {
  const key = keyFor(directory, sessionID, runtimeKey)
  gone.delete(key)
  listedGeneration.set(key, (listedGeneration.get(key) ?? 0) + 1)
}

/** Capture when a read starts; pass to `markSessionGone` with its 404. */
export function sessionListingGeneration(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): number {
  return listedGeneration.get(keyFor(directory, sessionID, runtimeKey)) ?? 0
}

/**
 * The open session answered 404 for a read that started at `generation`. True only when this newly marks it gone: false
 * when it already was, or a listing named it after the read started (the late 404 is stale).
 */
export function markSessionGone(directory: string, sessionID: string, generation: number, runtimeKey = getRuntimeKey()): boolean {
  const key = keyFor(directory, sessionID, runtimeKey)
  if (gone.has(key) || (listedGeneration.get(key) ?? 0) !== generation) return false
  gone.add(key)
  return true
}

/** Answered 404 and not listed or read successfully since: not read again in the background, even while viewed. */
export function isSessionGone(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): boolean {
  return gone.has(keyFor(directory, sessionID, runtimeKey))
}

export function isSessionReadSuppressed(directory: string, sessionID: string, now = Date.now(),
  runtimeKey = getRuntimeKey()): boolean {
  const key = keyFor(directory, sessionID, runtimeKey)
  const until = suppressedUntil.get(key)
  if (until === undefined) return false
  if (until > now) return true
  suppressedUntil.delete(key)
  return false
}

export function clearSessionReadFailures(): void {
  suppressedUntil.clear()
  gone.clear()
  listedGeneration.clear()
}
