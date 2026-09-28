import { expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, record, target } from "./session-message-loader-replace.fixture"

// smarty-code#583: the gateway's range read (?at=, x-smarty-at / x-smarty-total / x-smarty-index-epoch) gives every
// loaded record its position in the whole session, so the page can size the list to the session and load any window.
function gateway(size: number) {
  const g = { branch: Array.from({ length: size }, (_, i) => `m${String(i + 1).padStart(5, "0")}`), epoch: "e1", reads: [] as string[] }
  const client = fakeMessagesClient(async (input: { limit?: number; before?: string; $query_at?: number }) => {
    const limit = input.limit ?? 50
    const end = input.$query_at !== undefined ? Math.min(g.branch.length, input.$query_at + limit)
      : input.before ? g.branch.indexOf(JSON.parse(atob(input.before)).before) : g.branch.length
    const start = input.$query_at !== undefined ? input.$query_at : Math.max(0, end - limit)
    g.reads.push(input.$query_at !== undefined ? `at=${start}` : input.before ? "older" : "tail")
    const headers = new Headers({ "x-smarty-at": String(start), "x-smarty-total": String(g.branch.length), "x-smarty-index-epoch": g.epoch })
    if (start > 0) headers.set("x-next-cursor", btoa(JSON.stringify({ before: g.branch[start] })))
    return { data: g.branch.slice(start, end).map(record), headers }
  })
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: client, runtimeKey: "runtime-a" })
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((m) => m.id)
  return { g, loader, shown, done: () => { loader.dispose(); childStores.disposeAll() } }
}

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

test("a new index epoch (a branch change) drops the recorded ranges: positions start over", async () => {
  const s = gateway(1_000)
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    await s.loader.loadAt(target, 0, 100)
    s.g.epoch = "e2"
    await s.loader.loadAt(target, 500, 100)
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: "e2", ranges: [{ start: 500, end: 600 }] })
  } finally { s.done() }
})
