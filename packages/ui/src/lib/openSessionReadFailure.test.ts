import { afterEach, expect, test } from "bun:test"
import { noteSessionReadFailed, wireOpenSessionReadFailure } from "./openSessionReadFailure"

// smarty-code#811 (openchamber#410 review 2): the ended view waited 27.9 s for the next listing while the open session's
// own reads answered 503. A failed read of the open session asks for a fresh listing at once, at most every 3 s.
afterEach(() => wireOpenSessionReadFailure(undefined))
test("a failed read of the open session refreshes the managed listing at once, then at most every 3 s", () => {
  let refreshes = 0, now = 1_000
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, refresh: async () => { refreshes++ }, now: () => now })
  expect(noteSessionReadFailed("open")).toBe(true)
  now += 500; expect(noteSessionReadFailed("open")).toBe(false)
  now += 3_000; expect(noteSessionReadFailed("open")).toBe(true)
  expect(refreshes).toBe(2)
})
test("counterexamples: another session's failure, or a stock (unmanaged) server, refreshes nothing", () => {
  let refreshes = 0
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, refresh: async () => { refreshes++ } })
  expect(noteSessionReadFailed("other")).toBe(false)
  wireOpenSessionReadFailure({ current: () => "open", managed: () => false, refresh: async () => { refreshes++ } })
  expect(noteSessionReadFailed("open")).toBe(false)
  expect(refreshes).toBe(0)
})
