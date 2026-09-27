import { expect, test } from "bun:test"
import { record, setup, sleep, target } from "./session-message-loader-replace.fixture"

// smarty-code#497: a session shown as View only becomes ordinary. The first tail refresh replaces what was shown, as a
// first open, with the page's own coverage: merged into the View only coverage it left 11-100 missing, marked complete.
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `m${String(from + i).padStart(4, "0")}`)

test("the first tail refresh after View only replaces the shown history and adopts its cursor; older pages fill in", async () => {
  const s = setup()
  try {
    s.g.branch = ids(1, 10); await s.loader.ensure(target, { reason: "navigation" }) // View only, 1-10, complete.
    expect(s.loader.getSnapshot(target)).toMatchObject({ readOnly: true, complete: true })
    s.g.branch = ids(1, 130); s.g.readOnly = false // 120 more committed; the session is ordinary now.
    await s.loader.refreshTail(target, 30)
    expect(s.shown()).toEqual(ids(101, 130)) // Replaced, as a first open (not 1-10 plus 101-130),
    expect(s.loader.getSnapshot(target)).toMatchObject({ readOnly: false, complete: false }) // with the page's coverage:
    await s.loader.loadComplete(target) // "load older" offers 11-100.
    expect(s.shown()).toEqual(ids(1, 130))
  } finally { s.done() }
})

test("a live event during that read makes it stale: nothing commits, and a later read replaces", async () => {
  const s = setup()
  try {
    s.g.branch = ids(1, 10); await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ids(1, 130); s.g.readOnly = false; s.g.holdNext = true
    const refreshing = s.loader.refreshTail(target, 30)
    await sleep(5)
    await s.live({ id: "event-m0131", type: "message.updated", properties: { sessionID: target.sessionID, info: record("m0131").info } })
    s.g.holdNext = false; s.g.gates.shift()?.(); await refreshing
    expect(s.shown()).toEqual([...ids(1, 10), "m0131"]) // The stale read committed nothing; the live event stays.
    s.g.branch = ids(1, 131)
    await sleep(1_100) // The retry (1 s) reads again, with no event during it: it replaces.
    expect(s.shown()).toEqual(ids(102, 131))
    expect(s.loader.getSnapshot(target)).toMatchObject({ readOnly: false, complete: false })
  } finally { s.done() }
})

test("a tail refresh of a session still View only merges as before (the watch catch-up replaces separately)", async () => {
  const s = setup()
  try {
    s.g.branch = ids(1, 10); await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ids(1, 12)
    await s.loader.refreshTail(target, 5)
    expect(s.shown()).toEqual(ids(1, 12))
    expect(s.loader.getSnapshot(target)).toMatchObject({ readOnly: true, complete: true })
  } finally { s.done() }
})
