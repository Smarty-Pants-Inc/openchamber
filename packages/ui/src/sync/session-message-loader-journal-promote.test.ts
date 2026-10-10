import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, sleep } from "./session-message-loader-replace.fixture"

// smarty-code#867 + #1501: an open or send that joins a background journal re-read already out promotes it to a
// foreground read (retries a timeout, shows the error); a re-read nobody joins keeps its background semantics.
const directory = "/repo"
const at = { directory, sessionID: "ses_a" }
type MessageRecord = { info: Message; parts: Part[] }
const record = (id: string): MessageRecord => ({
  info: { id, sessionID: at.sessionID, role: "user", time: { created: 1 }, agent: "build",
    model: { providerID: "test", modelID: "test" } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: at.sessionID, type: "text", text: id }],
})

function gateway() {
  const releases: (() => void)[] = []
  const g = { reads: 0, hold: false, timeout: false, releases }
  const messages = async () => {
    g.reads++
    if (g.hold) await new Promise<void>((resolve) => g.releases.push(resolve))
    if (g.timeout) throw new Error("OpenCode request timed out after 6700ms")
    const headers = new Headers({ "x-smarty-journal-only": "1" })
    return { data: [record("j0001")], headers }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: fakeMessagesClient(messages), runtimeKey: "runtime-a",
    isViewed: () => false })
  const done = () => { g.releases.splice(0).forEach((release) => release()); loader.dispose(); childStores.disposeAll() }
  return { g, loader, done }
}

/** Shown journal-only, then a live nudge starts a background re-read that is held open and will time out. */
async function heldBackgroundRead() {
  const s = gateway()
  await s.loader.ensure(at, { reason: "navigation" })
  s.g.hold = true
  s.g.timeout = true
  s.loader.noteLiveUpdate(at)
  await sleep(20)
  expect(s.g.reads).toBe(2)
  return s
}

const release = (s: ReturnType<typeof gateway>) => { s.g.hold = false; s.g.releases.splice(0).forEach((r) => r()) }

test("an open that joins a running background journal re-read gets foreground retries and a visible error", async () => {
  const s = await heldBackgroundRead()
  try {
    const opened = s.loader.ensure(at, { reason: "navigation" })
    await sleep(20)
    expect(s.g.reads).toBe(2) // Joined: no second read while the first is out.
    release(s)
    await opened
    await sleep(1_800) // The foreground retries (+0.5 s, +1.5 s) of the timeout.
    expect(s.g.reads).toBeGreaterThanOrEqual(4)
    const snapshot = s.loader.getSnapshot(at)
    expect(snapshot.status).toBe("error")
    expect(snapshot.error).not.toBeNull()
  } finally { s.done() }
})

test("a send's refresh that joins a running background re-read promotes it too", async () => {
  const s = await heldBackgroundRead()
  try {
    void s.loader.refreshTail(at, 20)
    await sleep(20)
    release(s)
    await sleep(600) // The joined read now retries its timeout at +0.5 s, as a foreground read.
    expect(s.g.reads).toBeGreaterThanOrEqual(3)
  } finally { s.done() }
})

test("a background re-read nobody joins stays one read, ready, with no error", async () => {
  const s = await heldBackgroundRead()
  try {
    release(s)
    await sleep(700) // Past a foreground read's first retry (+0.5 s), before the 1 s backoff timer.
    expect(s.g.reads).toBe(2)
    const snapshot = s.loader.getSnapshot(at)
    expect(snapshot.status).toBe("ready")
    expect(snapshot.error).toBeNull()
    expect(snapshot.provisional).toBe(true)
  } finally { s.done() }
})
