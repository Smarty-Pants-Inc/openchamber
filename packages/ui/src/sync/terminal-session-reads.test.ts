import { afterEach, expect, test } from "bun:test"
import {
  clearSessionReadFailures,
  isSessionReadSuppressed,
  recordSessionReadFailure,
  TERMINAL_SESSION_READ_BACKOFF_MS,
} from "./terminal-session-reads"

afterEach(() => clearSessionReadFailures())

test("a terminal answer suppresses background re-reads of that session for a bounded time", () => {
  const now = 1_000
  for (const status of [404, 409, 410]) recordSessionReadFailure("/p", `s${status}`, { status }, now)
  for (const status of [404, 409, 410]) expect(isSessionReadSuppressed("/p", `s${status}`, now + 1)).toBe(true)
  expect(isSessionReadSuppressed("/other", "s404", now + 1)).toBe(false)
  expect(isSessionReadSuppressed("/p", "s404", now + TERMINAL_SESSION_READ_BACKOFF_MS)).toBe(false)
})

test("transient or unknown failures are not suppressed", () => {
  for (const error of [{ status: 503 }, { status: 500 }, new Error("network"), null]) recordSessionReadFailure("/p", "s", error)
  expect(isSessionReadSuppressed("/p", "s")).toBe(false)
})
