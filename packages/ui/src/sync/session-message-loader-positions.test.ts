import { expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, record, target } from "./session-message-loader-replace.fixture"

// smarty-code#583: the gateway's range read (?at=, x-smarty-at / x-smarty-total / x-smarty-index-epoch) gives every
// loaded record its position in the whole session, so the page can size the list to the session and load any window.
function gateway(size: number, cursors = true) {
  const windows: { start: number; end: number }[] = []
  const g = { branch: Array.from({ length: size }, (_, i) => `m${String(i + 1).padStart(5, "0")}`), epoch: "e1", reads: [] as string[], windows,
    /** The next reads answer without positions (the index is still building). */
    unindexed: 0,
    /** Holds the next window read's answer (computed now, delivered on release). */
    hold: null as null | { release: () => void } | "next" }
  const client = fakeMessagesClient(async (input: { limit?: number; before?: string; $query_at?: number; $query_epoch?: string }) => {
    if (input.$query_epoch !== undefined && input.$query_epoch !== g.epoch) {
      g.reads.push("409")
      throw Object.assign(new Error("index epoch changed"), { status: 409 })
    }
    const limit = input.limit ?? 50
    const at = input.$query_at !== undefined && input.$query_at < 0 ? Math.max(0, g.branch.length + input.$query_at) : input.$query_at
    const end = at !== undefined ? Math.min(g.branch.length, at + limit)
      : input.before ? g.branch.indexOf(JSON.parse(atob(input.before)).before) : g.branch.length
    const start = at !== undefined ? at : Math.max(0, end - limit)
    if (input.$query_at !== undefined && input.$query_at >= 0) g.windows.push({ start, end })
    g.reads.push(input.$query_at !== undefined && input.$query_at >= 0 ? `at=${start}` : input.before ? "older" : "tail")
    const headers = new Headers(g.unindexed > 0 ? {} : { "x-smarty-at": String(start), "x-smarty-total": String(g.branch.length), "x-smarty-index-epoch": g.epoch })
    if (g.unindexed > 0) g.unindexed--
    // While its index builds, the gateway answers the tail from the cursor contract: x-next-cursor while older ones remain.
    if (start > 0 && (cursors || input.$query_at === undefined || !headers.has("x-smarty-at"))) headers.set("x-next-cursor", btoa(JSON.stringify({ before: g.branch[start] })))
    const data = g.branch.slice(start, end).map(record)
    if (g.hold === "next" && input.$query_at !== undefined && input.$query_at >= 0) {
      await new Promise<void>((release) => { g.hold = { release } })
    }
    return { data, headers }
  })
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: client, runtimeKey: "runtime-a" })
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((m) => m.id)
  return { g, loader, shown, done: () => { loader.dispose(); childStores.disposeAll() } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test("a demand overlapping committed coverage reads only its missing suffix; fully covered repeats make no GET", async () => {
  const s = gateway(4_000)
  try {
    await s.loader.loadAt(target, 1942, 500)
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: 1942, end: 2442 }])
    s.g.windows.length = 0
    await s.loader.loadAt(target, 2200, 500)
    expect(s.g.windows).toEqual([{ start: 2442, end: 2700 }])
    await s.loader.loadAt(target, 2200, 500)
    await s.loader.loadAt(target, 1942, 758)
    expect(s.g.windows).toEqual([{ start: 2442, end: 2700 }])
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: 1942, end: 2700 }])
  } finally { s.done() }
})

test("a demand spanning committed islands reads every uncovered part and none of the islands", async () => {
  const s = gateway(4_000)
  try {
    await s.loader.loadAt(target, 2100, 100)
    await s.loader.loadAt(target, 2300, 100)
    s.g.windows.length = 0
    await s.loader.loadAt(target, 2000, 500)
    expect(s.g.windows).toEqual([{ start: 2000, end: 2100 }, { start: 2200, end: 2300 }, { start: 2400, end: 2500 }])
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: 2000, end: 2500 }])
  } finally { s.done() }
})

test("the first page tells the session's size and where the page sits in it", async () => {
  const s = gateway(10_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const positions = s.loader.getSnapshot(target).positions!
    expect(positions.total).toBe(10_000)
    expect(positions.ranges).toHaveLength(1)
    expect(positions.ranges[0]!.end).toBe(10_000)
    expect(s.loader.positionOf(target, "m10000")).toBe(9_999)
  } finally { s.done() }
})

test("a jump loads the window at any position; it merges in place and the ranges record it", async () => {
  const s = gateway(10_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const tail = s.loader.getSnapshot(target).positions!.ranges[0]!
    await s.loader.loadAt(target, 0, 100) // "Go to the beginning"
    expect(s.shown().slice(0, 3)).toEqual(["m00001", "m00002", "m00003"])
    expect(s.loader.positionOf(target, "m00001")).toBe(0)
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: 0, end: 100 }, tail])
    await s.loader.loadAt(target, 5_000, 100) // a scrollbar drag to the middle
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: 0, end: 100 }, { start: 5_000, end: 5_100 }, tail])
    expect(s.shown()).toContain("m05001")
  } finally { s.done() }
})

test("one read per window: the same window asked twice while it loads is read once", async () => {
  const s = gateway(1_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const before = s.g.reads.length
    await Promise.all([s.loader.loadAt(target, 0, 100), s.loader.loadAt(target, 0, 100)])
    expect(s.g.reads.length - before).toBe(1)
  } finally { s.done() }
})

test("a delayed window of the old epoch commits nothing after the epoch changes; a rewritten branch replaces the shown records", async () => {
  const s = gateway(1_000, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.hold = "next"
    const late = s.loader.loadAt(target, 0, 100) // an e1 window, answered after the change
    await settle()
    // The branch is rewritten: the last 200 records are replaced (a compaction or a branch switch), epoch e2.
    s.g.branch = [...s.g.branch.slice(0, 800), ...Array.from({ length: 150 }, (_, i) => `r${String(i + 1).padStart(5, "0")}`)]
    s.g.epoch = "e2"
    s.loader.noteIndex(target, s.g.branch.length, "e2")
    await settle()
    ;(s.g.hold as unknown as { release: () => void }).release()
    await late
    await settle()
    const shown = s.shown()
    expect(shown).not.toContain("m00001") // the late e1 window committed nothing
    expect(shown.some((id) => id.startsWith("m009"))).toBe(false) // records the rewrite removed are gone
    expect(shown.at(-1)).toBe("r00150")
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: "e2", total: 950 })
  } finally { s.done() }
})

test("a window asked with an old epoch gets 409: the loader starts over from the newest page", async () => {
  const s = gateway(1_000, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.epoch = "e2"
    await s.loader.loadAt(target, 300, 100)
    await settle()
    expect(s.g.reads.slice(-2)).toEqual(["409", "tail"])
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: "e2" })
  } finally { s.done() }
})

test("an older page, with positions, is the window just before the first loaded range", async () => {
  const s = gateway(1_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const first = s.loader.getSnapshot(target).positions!.ranges[0]!
    await s.loader.loadOlder(target)
    expect(s.loader.getSnapshot(target).positions!.ranges).toEqual([{ start: first.start - 100, end: 1_000 }])
    expect(s.g.reads.at(-1)).toBe(`at=${first.start - 100}`)
  } finally { s.done() }
})

test("reaching position 0 with holes after it is not complete; a full load (export) fills every hole, each record once", async () => {
  const s = gateway(1_000, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    await s.loader.loadAt(target, 0, 100)
    await s.loader.loadAt(target, 500, 100)
    expect(s.loader.getSnapshot(target).complete).toBe(false)
    await s.loader.loadComplete(target)
    expect(s.shown()).toEqual(s.g.branch)
    expect(s.loader.getSnapshot(target).complete).toBe(true)
  } finally { s.done() }
})

test("a full load right after an open whose page came without positions (index building) loads every record", async () => {
  const s = gateway(1_000, false)
  s.g.unindexed = 1
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.loader.getSnapshot(target).positions).toBeUndefined()
    await s.loader.loadComplete(target)
    expect(s.shown()).toEqual(s.g.branch)
  } finally { s.done() }
})

test("session.index grows the session without a read; a new epoch drops the ranges", async () => {
  const s = gateway(1_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const reads = s.g.reads.length, ranges = s.loader.getSnapshot(target).positions!.ranges
    s.loader.noteIndex(target, 1_050, "e1")
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ total: 1_050, ranges })
    expect(s.g.reads.length).toBe(reads)
    s.loader.noteIndex(target, 900, "e2")
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ total: 900, ranges: [], epoch: "e2" })
  } finally { s.done() }
})

test("a range read without a cursor (the gateway's at= answer) is not the whole history: older windows still load", async () => {
  const s = gateway(1_000, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.loader.getSnapshot(target).complete).toBe(false)
    await s.loader.loadOlder(target)
    expect(s.loader.getSnapshot(target).positions!.ranges[0]!.start).toBeLessThan(950)
  } finally { s.done() }
})

// openchamber#363 round 13 P1 1: fully load E1, then a TAIL refresh (not the index event) discovers E2: the coverage is
// the new one, so a full load (export) reads the whole new branch, each record once.
test("an epoch first discovered by a tail refresh does not keep the old epoch's completeness; a full load then reads the new branch", async () => {
  const s = gateway(300, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    await s.loader.loadComplete(target)
    expect(s.loader.getSnapshot(target).complete).toBe(true)
    s.g.branch = [...s.g.branch.slice(0, 100), ...Array.from({ length: 250 }, (_, i) => `r${String(i + 1).padStart(5, "0")}`)]
    s.g.epoch = "e2"
    await s.loader.refreshTail(target, 50)
    expect(s.loader.getSnapshot(target).complete).toBe(false)
    await s.loader.loadComplete(target)
    // Every record of the current branch, each exactly once (the fixture's creation times order r* among m*, so compare as sets).
    const shown = s.shown()
    expect(shown.length).toBe(s.g.branch.length)
    expect(new Set(shown)).toEqual(new Set(s.g.branch))
  } finally { s.done() }
})

// openchamber#363 round 13 follow-up (P2): an ordinary same-epoch tail refresh (session.idle) while a window is being
// read must not cancel that window: the reader is looking at its placeholder.
test("a same-epoch tail refresh does not cancel a window in flight", async () => {
  const s = gateway(1_000, false)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.hold = "next"
    const window = s.loader.loadAt(target, 400, 100)
    await settle()
    await s.loader.refreshTail(target, 50)
    ;(s.g.hold as unknown as { release: () => void }).release()
    await window
    expect(s.shown()).toContain("m00401")
    expect(s.loader.getSnapshot(target).positions!.ranges.some((r) => r.start <= 400 && r.end >= 500)).toBe(true)
  } finally { s.done() }
})

// Pin 46 review round 2 (smarty-code#968 5897200984): the CURRENT gateway (no #822) sends no position headers and no cursor
// when the newest page is the whole history, also when that history exactly fills the page (50 records; 30 on a
// constrained surface). That page is complete (the cursor contract), and a full load (Export) returns at once with every
// record once, instead of retrying a tail read until "made no progress".
function cursorOnlyGateway() {
  const g = { branch: [] as string[], reads: [] as string[] }
  const client = fakeMessagesClient(async (input: { limit?: number; before?: string }) => {
    const limit = input.limit ?? 50
    if (!g.branch.length) g.branch = Array.from({ length: limit }, (_, i) => `m${String(i + 1).padStart(5, "0")}`) // Exactly one page.
    const end = input.before ? g.branch.indexOf(JSON.parse(atob(input.before)).before) : g.branch.length
    const start = Math.max(0, end - limit)
    g.reads.push(`${input.before ? "older" : "tail"}:${limit}`)
    const headers = new Headers({ "x-smarty-read-only": "1", "x-smarty-read-only-branch": "persisted" }) // No positions, ever.
    if (start > 0) headers.set("x-next-cursor", btoa(JSON.stringify({ before: g.branch[start] })))
    return { data: g.branch.slice(start, end).map(record), headers }
  })
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: client, runtimeKey: "runtime-a" })
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((m) => m.id)
  return { g, loader, shown, done: () => { loader.dispose(); childStores.disposeAll() } }
}

test("a cursor-only gateway's newest page that exactly fills its limit, with no cursor, is the whole history; a full load finishes", async () => {
  const s = cursorOnlyGateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    const size = s.g.branch.length
    expect([30, 50]).toContain(size) // The initial page size of this surface: exactly full.
    expect(s.loader.getSnapshot(target).complete).toBe(true)
    await s.loader.loadComplete(target)
    expect(s.shown()).toEqual(s.g.branch)
    expect(s.g.reads).toEqual([`tail:${size}`])
  } finally { s.done() }
})

test("on a constrained (mobile) surface the same holds for an exactly full 30-record first page", async () => {
  const had = "window" in globalThis
  const w = globalThis as { window?: unknown }
  if (!had) w.window = { __OPENCHAMBER_SURFACE__: "mobile", location: { search: "" } }
  const s = cursorOnlyGateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.g.branch.length).toBe(had ? s.g.branch.length : 30)
    expect(s.loader.getSnapshot(target).complete).toBe(true)
    await s.loader.loadComplete(target)
    expect(s.shown()).toEqual(s.g.branch)
    expect(s.g.reads).toEqual([`tail:${s.g.branch.length}`])
  } finally { s.done(); if (!had) delete w.window }
})
