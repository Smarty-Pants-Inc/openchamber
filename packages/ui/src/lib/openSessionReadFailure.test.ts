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

// openchamber#410 review 4, P2 1: a successful catalog sample takes 35 s; its caller stops waiting at 30 s. The follow-up
// started at t=30 superseded it (a newer revision), so neither answer published. Now the sample's real end counts.
test("a slow successful sample (35 s, its caller settles at 30 s) with failures every 4 s: it publishes, no supersede", async () => {
  let now = 0, revision = 0, running = 0, maxRunning = 0; const published: number[] = [];
  let sample: Promise<void> | undefined; const answer: (() => void)[] = []; const callers: (() => void)[] = [];
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, now: () => now, sample: () => sample,
    refresh: () => { const mine = ++revision; running++; maxRunning = Math.max(maxRunning, running);
      sample = new Promise<void>((resolve) => { answer.push(() => { running--; if (mine === revision) published.push(now); sample = undefined; resolve(); }); });
      return new Promise<void>((resolve) => { callers.push(resolve); }); } })
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  noteSessionReadFailed("open")                                           // t=0: A
  for (const t of [4, 8, 12, 16, 20, 24, 28]) { now = t * 1000; noteSessionReadFailed("open") }
  now = 30_000; callers.shift()!(); await tick()                           // t=30: A's caller stops waiting; A still runs
  now = 32_000; noteSessionReadFailed("open"); await tick()
  expect(revision).toBe(1)                                                 // no B yet: A's sample still runs
  now = 35_000; answer.shift()!(); await tick()                            // t=35: A answers → publishes
  expect(published).toEqual([35_000])
  expect(revision).toBe(2)                                                 // then ONE follow-up B (gap long past)
  expect(maxRunning).toBe(1)
})

// openchamber#410 review 4, P2 2: A starts at 0, a failure at 0.25 queues a follow-up, A ends at 1 s. B started at once.
test("a queued follow-up after a 1 s sample waits for the 3 s gap; one follow-up only", async () => {
  const starts: number[] = []; const done: (() => void)[] = [];
  const clock = { t: 0 };
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, now: () => clock.t,
    refresh: () => { starts.push(clock.t); return new Promise<void>((r) => done.push(r)); } })
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  noteSessionReadFailed("open")                                 // t=0: A
  clock.t = 250; noteSessionReadFailed("open"); noteSessionReadFailed("open") // queued: one follow-up
  clock.t = 1_000; done.shift()!(); await tick()                 // A ends at 1 s
  expect(starts).toEqual([0])                                    // not at once
  clock.t = 3_000; await new Promise((r) => setTimeout(r, 2_050)); await tick() // the timer waits the rest of the gap
  expect(starts).toEqual([0, 3_000])
  for (const s of starts.slice(1)) expect(s - starts[starts.indexOf(s) - 1]).toBeGreaterThanOrEqual(3_000)
})

test("another caller's sample is running: no forced refresh over it; one follow-up after it ends", async () => {
  let other: (() => void) | undefined; let sample: Promise<void> | undefined = new Promise<void>((r) => { other = () => { sample = undefined; r(); }; });
  const starts: number[] = []; let now = 10_000
  wireOpenSessionReadFailure({ current: () => "open", managed: () => true, now: () => now, sample: () => sample,
    refresh: async () => { starts.push(now) } })
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  expect(noteSessionReadFailed("open")).toBe(false); noteSessionReadFailed("open")
  expect(starts).toEqual([])
  now = 12_000; other!(); await tick()
  expect(starts).toEqual([12_000])
})
