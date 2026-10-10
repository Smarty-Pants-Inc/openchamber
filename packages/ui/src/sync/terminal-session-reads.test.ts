import { afterEach, expect, test } from "bun:test"
import {
  clearSessionGone,
  clearSessionReadFailure,
  clearSessionReadFailures,
  isSessionGone,
  isSessionReadSuppressed,
  markSessionGone,
  recordSessionReadFailure,
  sessionListingGeneration,
  TERMINAL_SESSION_READ_BACKOFF_MS,
} from "./terminal-session-reads"

afterEach(() => clearSessionReadFailures())

test("a terminal answer suppresses background re-reads of that session for a bounded time", () => {
  const now = 1_000
  for (const status of [404, 409, 410]) recordSessionReadFailure("/p", `s${status}`, { status }, "rt", now)
  for (const status of [404, 409, 410]) expect(isSessionReadSuppressed("/p", `s${status}`, now + 1, "rt")).toBe(true)
  expect(isSessionReadSuppressed("/other", "s404", now + 1, "rt")).toBe(false)
  expect(isSessionReadSuppressed("/p", "s404", now + 1, "other-runtime")).toBe(false)
  clearSessionReadFailure("/p", "s409", "rt")
  expect(isSessionReadSuppressed("/p", "s409", now + 1, "rt")).toBe(false)
  expect(isSessionReadSuppressed("/p", "s404", now + TERMINAL_SESSION_READ_BACKOFF_MS, "rt")).toBe(false)
})

test("transient or unknown failures are not suppressed", () => {
  for (const error of [{ status: 503 }, { status: 500 }, new Error("network"), null]) recordSessionReadFailure("/p", "s", error)
  expect(isSessionReadSuppressed("/p", "s")).toBe(false)
})

// smarty-code#1575: the open session's 404 is gone with no expiry (gone wins over the back-off) until a 200 or a listing
// names it again; a 404 whose read started before such a listing is stale. A plain read failure never marks gone.
test("gone: no expiry, cleared by a 200 or a listing, and a 404 read from before the listing is stale", () => {
  const now = 1_000
  recordSessionReadFailure("/p", "s", { status: 404 }, "rt", now)
  expect(isSessionGone("/p", "s", "rt")).toBe(false) // Back-off only; other sessions keep just that.
  const started = sessionListingGeneration("/p", "s", "rt")
  expect(markSessionGone("/p", "s", started, "rt")).toBe(true)
  expect(markSessionGone("/p", "s", started, "rt")).toBe(false) // Already gone: the caller does nothing again.
  expect(isSessionGone("/other", "s", "rt")).toBe(false)
  expect(isSessionGone("/p", "s", "other-runtime")).toBe(false)
  expect(isSessionReadSuppressed("/p", "s", now + TERMINAL_SESSION_READ_BACKOFF_MS, "rt")).toBe(false)
  expect(isSessionGone("/p", "s", "rt")).toBe(true)
  clearSessionGone("/p", "s", "rt")
  expect(isSessionGone("/p", "s", "rt")).toBe(false)
  expect(markSessionGone("/p", "s", started, "rt")).toBe(false) // Read started before that listing: stale.
  expect(markSessionGone("/p", "s", sessionListingGeneration("/p", "s", "rt"), "rt")).toBe(true)
  clearSessionReadFailure("/p", "s", "rt")
  expect(isSessionGone("/p", "s", "rt")).toBe(false)
})
