import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, sleep } from "./session-message-loader-replace.fixture"
import { showsViewOnly } from "@/lib/herdrSession"

// smarty-code#1501: a busy session's newest page served from its committed journal (`x-smarty-journal-only: 1`) is shown
// at once with the composer live and marked provisional; the next normal answer replaces it (never merged).
const target = { directory: "/repo", sessionID: "session-a" }
type MessageRecord = { info: Message; parts: Part[] }
const record = (id: string): MessageRecord => ({
  info: { id, sessionID: target.sessionID, role: "user", time: { created: Number(id.slice(1)) }, agent: "build",
    model: { providerID: "test", modelID: "test" } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: "text", text: id }],
})
const JOURNAL = ["j0001", "j0003"] // The journal's native ids: they differ from the normal answer's.
const NORMAL = ["m0001", "m0002", "m0003"]

/** A gateway answering journal-only while `busy`, else normally (the newest `limit`, x-next-cursor while older remain). */
function gateway() {
  const g = { busy: true, reads: 0 }
  const messages = async ({ limit, before }: { limit?: number; before?: string }) => {
    g.reads++
    const headers = new Headers()
    if (g.busy) { headers.set("x-smarty-journal-only", "1"); return { data: JOURNAL.map(record), headers } }
    const end = before ? NORMAL.indexOf(before) : NORMAL.length, start = Math.max(0, end - (limit ?? NORMAL.length))
    if (start > 0) headers.set("x-next-cursor", NORMAL[start]!)
    return { data: NORMAL.slice(start, end).map(record), headers }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: fakeMessagesClient(messages), runtimeKey: "runtime-a" })
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((m) => m.id)
  const done = () => { loader.dispose(); childStores.disposeAll() }
  return { g, loader, shown, done }
}

test("a journal-only answer is shown at once, composer live, provisional, with no load earlier", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.shown()).toEqual(JOURNAL)
    const snapshot = s.loader.getSnapshot(target)
    expect(snapshot.status).toBe("ready")
    expect(snapshot.provisional).toBe(true)
    expect(snapshot.readOnly).toBe(false)
    expect(showsViewOnly(snapshot.readOnly, null)).toBe(false) // The composer stays (not a View only session).
    expect(snapshot.cursor).toBeUndefined() // ChatContainer offers "load earlier" only with a cursor.
    expect(snapshot.complete).toBe(false)
    expect(s.loader.isOrdinary(target, "runtime-a")).toBe(false)
  } finally { s.done() }
})

test("the backoff re-read's normal answer replaces the journal-only records, never merges them", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.busy = false
    await sleep(1_200) // First re-read after 1 s.
    expect(s.shown()).toEqual(NORMAL) // No j-records left, no duplicates.
    expect(s.loader.getSnapshot(target).provisional).toBe(false)
    const reads = s.g.reads
    await sleep(2_300)
    expect(s.g.reads).toBe(reads) // The wait ended: no more re-reads.
  } finally { s.done() }
})

test("still busy: the re-reads continue with a backoff and keep the journal-only records", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    await sleep(3_300) // Re-reads at 1 s and 1 + 2 s.
    expect(s.g.reads).toBe(3)
    expect(s.shown()).toEqual(JOURNAL)
    expect(s.loader.getSnapshot(target).provisional).toBe(true)
  } finally { s.done() }
})

test("the live stream's first update re-reads at once", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.busy = false
    s.loader.noteLiveUpdate(target)
    s.loader.noteLiveUpdate(target) // Only the first update asks.
    await sleep(50)
    expect(s.g.reads).toBe(2)
    expect(s.shown()).toEqual(NORMAL)
  } finally { s.done() }
})

test("a journal-only answer after a normal one is stale: ignored, the normal records stay", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.busy = false
    s.loader.noteLiveUpdate(target)
    await sleep(50)
    expect(s.shown()).toEqual(NORMAL)
    const coverage = { ...s.loader.getSnapshot(target) }
    s.g.busy = true // A later read of the busy session answers journal-only again.
    await s.loader.refreshTail(target, 50)
    expect(s.shown()).toEqual(NORMAL)
    const after = s.loader.getSnapshot(target)
    expect(after.provisional).toBe(false)
    expect(after.status).toBe("ready")
    expect(after.cursor).toBe(coverage.cursor)
    expect(after.complete).toBe(coverage.complete)
  } finally { s.done() }
})

test("no header: today's behaviour (no provisional marker, its own coverage, no re-reads)", async () => {
  const s = gateway()
  s.g.busy = false
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.shown()).toEqual(NORMAL)
    const snapshot = s.loader.getSnapshot(target)
    expect("provisional" in snapshot).toBe(false)
    expect(snapshot.complete).toBe(true)
    s.loader.noteLiveUpdate(target)
    await sleep(1_200)
    expect(s.g.reads).toBe(1)
  } finally { s.done() }
})

test("a session invalidated (deleted or archived) during journal-only polling stops re-reading (#1501 review)", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    expect(s.loader.getSnapshot(target).provisional).toBe(true)
    const reads = s.g.reads
    s.loader.invalidateSession(target)
    await sleep(3_300) // The 1 s and 2 s re-reads would have run.
    expect(s.g.reads).toBe(reads)
  } finally { s.done() }
})
