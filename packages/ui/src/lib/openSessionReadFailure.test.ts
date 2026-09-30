import { afterEach, expect, test } from "bun:test"
import { noteSessionReadFailed, wireOpenSessionReadFailure } from "./openSessionReadFailure"

// smarty-code#811 (openchamber#410 review 2): the ended view waited 27.9 s for the next listing while the open session's
// own reads answered 503. A failed read of the open session asks for a fresh listing at once, at most every 3 s.
afterEach(() => wireOpenSessionReadFailure(undefined))
test("a failed read of the open session refreshes the managed listing at once, then at most every 3 s", async () => {
  let refreshes = 0, now = 1_000
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, refresh: async () => { refreshes++ }, now: () => now })
  expect(noteSessionReadFailed("open")).toBe(true); await settled()
  now += 500; expect(noteSessionReadFailed("open")).toBe(false)
  now += 3_000; expect(noteSessionReadFailed("open")).toBe(true); await settled()
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

// openchamber#410 review 3: the unavailable session's reads fail every 4 s while a successful listing takes 5 s. Each
// forced refresh superseded the running one (a newer revision), so no listing ever published the ended row.
test("failures every 4 s with a 5 s listing: one refresh at a time, each publishes, one follow-up", async () => {
  let now = 0, revision = 0, running = 0, maxRunning = 0; const published: number[] = [], pending: (() => void)[] = [];
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, now: () => now,
    refresh: () => { const mine = ++revision; running++; maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve) => { pending.push(() => { running--; if (mine === revision) published.push(now); resolve(); }); }); } })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  noteSessionReadFailed("open")                 // t=0: failure → refresh A
  now = 4_000; noteSessionReadFailed("open")    // t=4: failure while A runs → a follow-up, not a new refresh
  now = 5_000; pending.shift()!(); await tick() // t=5: A answers → publishes; the follow-up B starts
  now = 8_000; noteSessionReadFailed("open")    // t=8: failure while B runs
  now = 10_000; pending.shift()!(); await tick() // t=10: B answers → publishes; follow-up C
  expect(published).toEqual([5_000, 10_000])
  expect(maxRunning).toBe(1)
  expect(revision).toBe(3) // A, B and one follow-up C: bounded.
})
