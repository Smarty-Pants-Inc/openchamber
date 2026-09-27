import { expect, test } from "bun:test"
import { record, setup, sleep, target } from "./session-message-loader-replace.fixture"

test("two overlapping recoveries: the older one's late return never turns the newer reset into a merge", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" }); expect(s.shown()).toEqual(["m0001", "m0002"])
    s.g.holdNext = true
    const older = s.loader.replaceHistory(target, [5]) // Its read serves [m0001, m0002] and is held.
    await sleep(5)
    s.g.branch = ["m0001", "m0003"] // The branch changes (no live event reaches this page).
    const newer = s.loader.replaceHistory(target, [5]) // Its read serves [m0001, m0003] and is held too.
    await sleep(5); s.g.holdNext = false
    s.g.gates.shift()?.(); await older // The older response returns first: superseded, it must leave the reset state alone.
    s.g.gates.shift()?.(); await newer
    expect(s.shown()).toEqual(["m0001", "m0003"]) // A reset, not a merge that keeps m0002.
    expect(s.loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true, complete: true })
  } finally { s.done() }
})

test("a recovery whose read fails retries until a reset commits", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ["m0001", "m0003"]; s.g.failNext = true
    await s.loader.replaceHistory(target, [5])
    expect(s.shown()).toEqual(["m0001", "m0003"]); expect(s.g.reads).toBe(3) // The first open, a failed read, a clean one.
  } finally { s.done() }
})

test("a recovery released while it waits or reads stops: no read after its release, and no reset state left behind", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const release = new AbortController()
    s.g.failNext = true // Its first read fails, so it waits to retry,
    const recovering = s.loader.replaceHistory(target, [50], release.signal)
    await sleep(10); release.abort(); await recovering // and the watch is released meanwhile.
    const reads = s.g.reads; await sleep(80)
    expect(s.g.reads).toBe(reads) // No read after the release.
    s.g.branch = ["m0001", "m0004"]
    await s.loader.refreshTail(target, 50) // A later ordinary refresh merges (no reset state was left armed).
    expect(s.shown()).toEqual(["m0001", "m0002", "m0004"])
  } finally { s.done() }
})

test("a live removal of a message not yet shown, during the read, makes the read stale: never resurrected", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ["m0001", "m0003"]; s.g.holdNext = true // m0003 was created while hidden; the read serves it, held.
    const recovering = s.loader.replaceHistory(target, [5])
    await sleep(5); s.g.holdNext = false; s.g.branch = ["m0001"]
    await s.live({ id: "evt_removed_m0003", type: "message.removed", properties: { sessionID: target.sessionID, messageID: "m0003" } }) // A no-op here.
    s.g.gates.shift()?.(); await recovering
    expect(s.shown()).toEqual(["m0001"]) // The stale read was not applied; the retry's read was.
  } finally { s.done() }
})

test("a watch released while its recovery reads: the late response is not applied, and no request follows", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const release = new AbortController()
    s.g.branch = ["m0001", "m0003"]; s.g.holdNext = true
    const recovering = s.loader.replaceHistory(target, [5], release.signal)
    await sleep(5); s.g.holdNext = false; release.abort()
    const reads = s.g.reads; s.g.gates.shift()?.(); await recovering; await sleep(40)
    expect(s.shown()).toEqual(["m0001", "m0002"]); expect(s.g.reads).toBe(reads)
  } finally { s.done() }
})

test("while a recovery reads or waits, the page's coverage stays settled and ordinary loads run on it", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const settled = s.loader.getSnapshot(target)
    s.g.failNext = true
    const older = s.loader.replaceHistory(target, [30]) // Fails, then waits in backoff,
    await sleep(5); s.g.holdNext = true
    const newer = s.loader.replaceHistory(target, [30]) // and a newer recovery takes over; its read is held.
    await sleep(5); s.g.holdNext = false
    expect(s.loader.getSnapshot(target)).toMatchObject({ status: settled.status, resolved: true, complete: settled.complete })
    await s.live({ id: "evt_updated_m0005", type: "message.updated", properties: { sessionID: target.sessionID, info: record("m0005").info } }) // Stale for the newer one,
    await s.loader.refreshTail(target, 1) // and an ordinary refresh commits meanwhile: it merges as usual.
    expect(s.loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true })
    s.g.branch = ["m0001", "m0006"]; s.g.gates.shift()?.()
    await Promise.all([older, newer])
    expect(s.shown()).toEqual(["m0001", "m0006"]) // Once quiet, the newer recovery's reset commits.
    expect(s.loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true, complete: true })
  } finally { s.done() }
})

test("a refresh requested after a reset committed runs, even with an older load and a queued refresh still pending", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.holdNext = true
    const older = s.loader.refreshTail(target, 50) // An ordinary load, held,
    const queued = s.loader.refreshTail(target, 50) // with a refresh queued behind it.
    await sleep(5); s.g.holdNext = false
    s.g.branch = ["m0001", "m0003"]
    await s.loader.replaceHistory(target, [5]) // The reset commits and retires both.
    s.g.branch = ["m0001", "m0003", "m0007"]
    await s.loader.refreshTail(target, 50) // A later request is not swallowed by the retired queue.
    expect(s.shown()).toEqual(["m0001", "m0003", "m0007"])
    s.g.gates.shift()?.(); await Promise.all([older, queued])
    expect(s.shown()).toEqual(["m0001", "m0003", "m0007"]) // The older load's [m0001, m0002] never merges back.
  } finally { s.done() }
})

test("another load that commits during the read, even changing nothing, makes the read stale", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.holdNext = true
    const recovering = s.loader.replaceHistory(target, [5])
    await sleep(5); s.g.holdNext = false
    await s.loader.refreshTail(target, 50) // Same records: nothing changes, but it committed.
    s.g.gates.shift()?.(); await recovering
    expect(s.g.reads).toBe(4) // The first open, the held read (stale), the refresh, the retry.
  } finally { s.done() }
})

test("a recovery whose watch was already released never supersedes the current one", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ["m0001", "m0003"]; s.g.holdNext = true
    const current = s.loader.replaceHistory(target, [5])
    await sleep(5); s.g.holdNext = false
    const released = new AbortController(); released.abort()
    await s.loader.replaceHistory(target, [5], released.signal) // A late open of a released watch.
    s.g.gates.shift()?.(); await current
    expect(s.shown()).toEqual(["m0001", "m0003"])
  } finally { s.done() }
})

test("a session that left View only during a recovery ends it: no retry, and the page is left to ordinary loading", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.readOnly = false; s.g.branch = ["m0001", "m0003"]
    await s.loader.replaceHistory(target, [5])
    expect(s.g.reads).toBe(2) // The first open and the recovery's read; no retry, no replacement.
    expect(s.shown()).toEqual(["m0001", "m0002"])
  } finally { s.done() }
})

test("a load a subscriber starts while the reset publishes waits for, and starts from, the reset's coverage", async () => {
  const s = setup()
  try {
    s.g.branch = Array.from({ length: 300 }, (_, i) => `m${String(i + 1).padStart(4, "0")}`)
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = [...s.g.branch, ...Array.from({ length: 100 }, (_, i) => `n${String(i + 301).padStart(4, "0")}`)] // 100 more.
    let older: Promise<void> | undefined
    const stop = s.store().subscribe(() => { older ??= s.loader.loadOlder(target) }) // Re-enters as the reset publishes.
    await s.loader.replaceHistory(target, [5]); stop(); await older
    const ids = s.shown()
    expect(ids.length).toBe(150) // The reset's page and one older page from its cursor,
    expect(ids).toEqual(s.g.branch.slice(-150)) // contiguous: the old cursor would skip n0301 to n0350.
  } finally { s.done() }
})
