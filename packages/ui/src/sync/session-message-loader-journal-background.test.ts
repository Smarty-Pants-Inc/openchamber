import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, sleep } from "./session-message-loader-replace.fixture"

// smarty-code#867 + #1501 composed: a session nobody views, shown from a journal-only answer, is re-read (backoff timer,
// first live update) as a capped background read; the viewed session's re-reads and an open never wait behind them.
const directory = "/repo"
const VIEWED = "ses_viewed"
type MessageRecord = { info: Message; parts: Part[] }
const record = (sessionID: string, id: string): MessageRecord => ({
  info: { id, sessionID, role: "user", time: { created: Number(id.slice(1)) }, agent: "build",
    model: { providerID: "test", modelID: "test" } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: id }],
})

/** Every session busy (journal-only answers) until `busy` clears; `hold` keeps reads open until released. */
function gateway() {
  const reads: string[] = [], releases: (() => void)[] = []
  const g = { busy: true, hold: false, timeout: false, inFlight: new Map<string, number>(), peakBackground: 0, reads, releases }
  const background = () => [...g.inFlight].filter(([id]) => id !== VIEWED).reduce((sum, [, n]) => sum + n, 0)
  // The loader passes its target's sessionID in the same request object (fetchPage).
  const messages = async (input: { limit?: number; before?: string; sessionID?: string }) => {
    const sessionID = input.sessionID ?? ""
    g.reads.push(sessionID)
    g.inFlight.set(sessionID, (g.inFlight.get(sessionID) ?? 0) + 1)
    g.peakBackground = Math.max(g.peakBackground, background())
    try {
      if (g.hold) await new Promise<void>((resolve) => g.releases.push(resolve))
      if (g.timeout) throw new Error("OpenCode request timed out after 6700ms")
      const headers = new Headers()
      if (g.busy) { headers.set("x-smarty-journal-only", "1"); return { data: [record(sessionID, "j0001")], headers } }
      return { data: [record(sessionID, "m0001"), record(sessionID, "m0002")], headers }
    } finally { g.inFlight.set(sessionID, (g.inFlight.get(sessionID) ?? 1) - 1) }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: fakeMessagesClient(messages), runtimeKey: "runtime-a",
    isViewed: (target) => target.sessionID === VIEWED })
  const shown = (sessionID: string) => (childStores.getChild(directory)?.getState().message[sessionID] ?? []).map((m) => m.id)
  const done = () => { g.releases.splice(0).forEach((release) => release()); loader.dispose(); childStores.disposeAll() }
  return { g, loader, shown, done }
}
const unviewed = ["ses_a", "ses_b", "ses_c", "ses_d"]
const at = (sessionID: string) => ({ directory, sessionID })

test("journal-only re-reads of unviewed sessions (timer and live update) run at most two at once", async () => {
  const s = gateway()
  try {
    for (const id of unviewed) await s.loader.ensure(at(id), { reason: "navigation" }) // Shown journal-only.
    const before = s.g.reads.length
    s.g.hold = true
    for (const id of unviewed) s.loader.noteLiveUpdate(at(id)) // The live stream nudges every one at once.
    await sleep(20)
    expect(s.g.peakBackground).toBeLessThanOrEqual(2)
    expect(s.g.reads.length - before).toBe(2)
    // The backoff timers (1 s) fire while those reads are still pending: still at most two.
    await sleep(1_100)
    expect(s.g.peakBackground).toBeLessThanOrEqual(2)
    s.g.hold = false
    for (let guard = 0; guard < 50 && s.g.releases.length; guard++) { s.g.releases.shift()?.(); await sleep(5) }
    await sleep(50)
    expect(s.g.peakBackground).toBe(2)
    for (const id of unviewed) expect(s.g.reads.slice(before)).toContain(id) // Every one was re-read.
  } finally { s.done() }
})

test("a timed-out background journal re-read is not retried at once and shows no error; a normal answer replaces", async () => {
  const s = gateway()
  try {
    await s.loader.ensure(at("ses_a"), { reason: "navigation" })
    expect(s.shown("ses_a")).toEqual(["j0001"])
    s.g.timeout = true
    const before = s.g.reads.length
    await sleep(2_800) // The 1 s timer re-reads, in the background (a foreground read retries at +0.5 s and +1.5 s).
    expect(s.g.reads.length - before).toBe(1) // No immediate retry; the next re-read is the 1 + 2 s timer.
    const snapshot = s.loader.getSnapshot(at("ses_a"))
    expect(snapshot.status).not.toBe("error")
    expect(snapshot.error).toBeNull()
    expect(snapshot.provisional).toBe(true)
    expect(s.shown("ses_a")).toEqual(["j0001"])
    s.g.timeout = false
    s.g.busy = false
    await sleep(500) // The 1 + 2 s re-read answers normally: REPLACE, the journal id is gone.
    expect(s.shown("ses_a")).toEqual(["m0001", "m0002"])
    expect(s.loader.getSnapshot(at("ses_a")).provisional).toBe(false)
  } finally { s.done() }
})

test("with both background slots held, the viewed session's re-read and an open are read at once", async () => {
  const s = gateway()
  try {
    for (const id of [...unviewed, VIEWED]) await s.loader.ensure(at(id), { reason: "navigation" })
    s.g.hold = true
    for (const id of unviewed) s.loader.noteLiveUpdate(at(id))
    await sleep(20)
    expect(s.g.inFlight.get(VIEWED) ?? 0).toBe(0)
    const before = s.g.reads.length
    s.loader.noteLiveUpdate(at(VIEWED)) // The viewed session's live update: not capped.
    await sleep(20)
    expect(s.g.reads.slice(before)).toEqual([VIEWED])
    // Opening a queued unviewed session reads it at once too, ahead of its capped re-read.
    void s.loader.ensure(at("ses_d"), { reason: "navigation" })
    await sleep(20)
    expect(s.g.reads.slice(before)).toEqual([VIEWED, "ses_d"])
    expect(s.g.peakBackground).toBeLessThanOrEqual(3) // Two capped reads plus the person's own open.
  } finally { s.done() }
})
