import { expect, test } from "bun:test"
import { setup, sleep, target } from "./session-message-loader-replace.fixture"

// smarty-code#583 on 3.46: on a busy session each live event queues a tail refresh behind the load in flight, and it ran
// before the reader's older page, so the scroll-back got an older page only now and then (none for 185 s). The older page
// goes first; the refresh follows it; the older page always extends the coverage it was requested on (its cursor is read
// when it starts, after the in-flight load committed), so the shown range stays contiguous.
const branch = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i + 1).padStart(4, "0")}`)

test("an older page requested behind an in-flight load goes before the tail refresh queued behind that load", async () => {
  const s = setup()
  try {
    s.g.readOnly = false; s.g.branch = branch(600)
    await s.loader.ensure(target, { reason: "navigation" })
    const order: string[] = []
    const reads = s.g.reads, first = s.shown().length
    s.g.holdNext = true
    const inflight = s.loader.refreshTail(target, 50) // A live event's refresh, in flight (held).
    await sleep(5); s.g.holdNext = false
    const queued = s.loader.refreshTail(target, 50) // Another live event: queued behind it.
    const older = s.loader.loadOlder(target).then(() => order.push("older")) // The reader reaches the top.
    void queued.then(() => order.push("refresh"))
    s.g.gates.shift()?.()
    await Promise.all([inflight, queued, older])
    expect(order).toEqual(["older", "refresh"])
    expect(s.g.reads - reads).toBe(3) // The held refresh, the older page, then the queued refresh: nothing re-read.
    expect(s.shown().length).toBe(first + 100) // The older page is in,
    expect(s.shown()).toEqual(branch(600).slice(-(first + 100))) // and it extends the shown range: no gap, no repeat.
  } finally { s.done() }
})

test("under a stream of live events, older pages keep coming: each goes before the refreshes that queued meanwhile", async () => {
  const s = setup()
  try {
    s.g.readOnly = false; s.g.branch = branch(900)
    await s.loader.ensure(target, { reason: "navigation" })
    const before = s.shown().length
    for (let page = 0; page < 4; page++) {
      s.g.holdNext = true
      const busy = s.loader.refreshTail(target, 50)
      await sleep(2); s.g.holdNext = false
      const refreshes = [s.loader.refreshTail(target, 50), s.loader.refreshTail(target, 50)]
      const older = s.loader.loadOlder(target)
      s.g.gates.shift()?.()
      await Promise.all([busy, older, ...refreshes])
    }
    expect(s.shown().length).toBe(before + 400) // Four older pages, none lost behind the refreshes,
    expect(s.shown()).toEqual(branch(900).slice(-(before + 400))) // each from the coverage it extends.
  } finally { s.done() }
})
