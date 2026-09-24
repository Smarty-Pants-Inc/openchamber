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
}
