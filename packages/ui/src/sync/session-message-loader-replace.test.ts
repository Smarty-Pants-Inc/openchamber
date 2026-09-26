import { expect, test } from "bun:test"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

// openchamber#278: a View only watch re-acquired after the page missed entries replaces the shown history with a fresh
// newest page (its own cursor and completeness), through the real loader.
const target = { directory: "/repo", sessionID: "session-a" }
const record = (id: string, created: number) => ({
  info: { id, sessionID: target.sessionID, role: "user", time: { created } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: "text", text: id }] as Part[],
})
/** A View only gateway: the persisted branch, newest `limit` before `before`, x-next-cursor while older ones remain. */
function gateway(branch: string[]) {
  const messages = async (input: { limit?: number; before?: string }) => {
    const end = input.before ? branch.indexOf(input.before) : branch.length
    const start = Math.max(0, end - (input.limit ?? branch.length))
    const cursor = start > 0 ? branch[start] : undefined
    return { data: branch.slice(start, end).map((id) => record(id, Number(id.slice(1)))),
      response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : name === "x-smarty-read-only" ? "1" : null } } }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: { session: { messages } } as unknown as OpencodeClient, runtimeKey: "runtime-a" })
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((message) => message.id)
  const done = () => { loader.dispose(); childStores.disposeAll() }
  return { loader, shown, done }
}
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `m${String(from + i).padStart(4, "0")}`)

test("hidden, then 120 committed, then shown: the transcript is correct and older pages load without a gap", async () => {
  const branch = ids(1, 10), g = gateway(branch)
  try {
    await g.loader.ensure(target, { reason: "navigation" })
    expect(g.shown()).toEqual(ids(1, 10)); expect(g.loader.getSnapshot(target).complete).toBe(true)
    branch.push(...ids(11, 130)) // Committed while the view was hidden.
    await g.loader.replaceHistory(target) // Shown again: the watch is re-acquired.
    const fresh = g.loader.getSnapshot(target)
    expect(g.shown().at(-1)).toBe("m0130"); expect(fresh.complete).toBe(false); expect(fresh.cursor).toBeDefined()
    for (let i = 0; i < 20 && !g.loader.getSnapshot(target).complete; i++) await g.loader.loadOlder(target)
    expect(g.shown()).toEqual(ids(1, 130)) // Every record, in order, none missing.
  } finally { g.done() }
})

test("a persisted branch changed while hidden: the new branch is shown, the old one removed", async () => {
  const branch = ["m0001", "m0002"], g = gateway(branch) // root, old-branch
  try {
    await g.loader.ensure(target, { reason: "navigation" })
    expect(g.shown()).toEqual(["m0001", "m0002"])
    branch.splice(1, 1, "m0003") // Pi selected another branch from the root and appended to it.
    await g.loader.replaceHistory(target)
    expect(g.shown()).toEqual(["m0001", "m0003"])
  } finally { g.done() }
})

// #278 review 4: a delayed replacement never erases newer live events applied while its read was in flight.
test("a held replacement response, with an update and a removal applied meanwhile, leaves the newer state", async () => {
  const { applyDirectoryEvent } = await import("./event-reducer")
  let branch = ["m0001", "m0002"], hold: Promise<void> | undefined
  const reads: string[][] = []
  const messages = async (input: { limit?: number; before?: string }) => {
    const at = [...branch]; reads.push(at) // What the gateway had when the read was served (its new baseline),
    if (hold) await hold // and the response reaches the page later.
    const end = input.before ? at.indexOf(input.before) : at.length, start = Math.max(0, end - (input.limit ?? at.length))
    return { data: at.slice(start, end).map((id) => record(id, Number(id.slice(1)))),
      response: { headers: { get: (name: string) => name === "x-next-cursor" ? (start > 0 ? at[start] : null) : name === "x-smarty-read-only" ? "1" : null } } }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: { session: { messages } } as unknown as OpencodeClient, runtimeKey: "runtime-a" })
  const store = () => childStores.ensureChild(target.directory, { bootstrap: false })
  const shown = () => (store().getState().message[target.sessionID] ?? []).map((message) => message.id)
  const live = (event: unknown) => { // The page's event path: a shallow draft, the real reducer, then the store.
    const state = store().getState(), draft = { ...state, message: { ...state.message }, part: { ...state.part } }
    applyDirectoryEvent(draft as never, event as never); store().setState(draft)
  }
  try {
    await loader.ensure(target, { reason: "navigation" }); expect(shown()).toEqual(["m0001", "m0002"])
    let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve })
    const replacing = loader.replaceHistory(target, [5]) // Its read serves [m0001, m0002] and is held.
    await new Promise((resolve) => setTimeout(resolve, 5))
    branch = ["m0001", "m0003"] // Pi moves the branch; the gateway publishes the change live:
    live({ type: "message.updated", properties: { info: record("m0003", 3).info } })
    live({ type: "message.part.updated", properties: { sessionID: target.sessionID, part: record("m0003", 3).parts[0] } })
    live({ type: "message.removed", properties: { sessionID: target.sessionID, messageID: "m0002" } })
    expect(shown()).toEqual(["m0001", "m0003"])
    hold = undefined; release(); await replacing // The older response arrives last.
    expect(shown()).toEqual(["m0001", "m0003"]) // The newer state survives,
    expect(store().getState().part["m0003"]?.map((part) => part.id)).toEqual(["part_m0003"]) // parts included,
    expect(reads.length).toBe(3) // after one stale read and a fresh one (the gateway's new baseline).
  } finally { loader.dispose(); childStores.disposeAll() }
})

test("a page that keeps moving never loses a live update or removal, and the replacement converges once quiet", async () => {
  const { applyDirectoryEvent } = await import("./event-reducer")
  const branch = ["m0001", "m0002"]
  const quietAfter = 6 // The first open, then four reads each overlapped by a live change, then quiet.
  let reads = 0
  const store = () => childStores.ensureChild(target.directory, { bootstrap: false })
  const live = (event: unknown) => {
    const state = store().getState(), draft = { ...state, message: { ...state.message }, part: { ...state.part } }
    applyDirectoryEvent(draft as never, event as never); store().setState(draft)
  }
  const messages = async () => {
    const at = [...branch]; reads++
    if (reads > 1 && reads < 5) { // Pi commits while this read is in flight.
      const id = `m${String(reads + 1).padStart(4, "0")}`; branch.push(id)
      live({ type: "message.updated", properties: { info: record(id, Number(id.slice(1))).info } })
    }
    if (reads === 5) { // This read (the old merge fallback's) still serves m0002, which is removed while it is in flight.
      branch.splice(branch.indexOf("m0002"), 1); live({ type: "message.removed", properties: { sessionID: target.sessionID, messageID: "m0002" } })
    }
    return { data: at.map((id) => record(id, Number(id.slice(1)))), response: { headers: { get: (name: string) => name === "x-smarty-read-only" ? "1" : null } } }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: { session: { messages } } as unknown as OpencodeClient, runtimeKey: "runtime-a" })
  const shown = () => (store().getState().message[target.sessionID] ?? []).map((message) => message.id)
  try {
    await loader.ensure(target, { reason: "navigation" })
    const seen: string[][] = []
    const unsubscribe = childStores.ensureChild(target.directory, { bootstrap: false }).subscribe(() => seen.push(shown()))
    await loader.replaceHistory(target, [5])
    unsubscribe()
    // Never lost: once a live entry was shown it stays shown, and the removed one never comes back.
    const added = ["m0003", "m0004", "m0005"]
    for (const id of added) { const first = seen.findIndex((ids) => ids.includes(id)); expect(first).toBeGreaterThanOrEqual(0); expect(seen.slice(first).every((ids) => ids.includes(id))).toBe(true) }
    const gone = seen.findIndex((ids) => !ids.includes("m0002")); expect(seen.slice(gone).every((ids) => !ids.includes("m0002"))).toBe(true)
    expect(shown()).toEqual(branch) // Converged on the gateway's branch once quiet,
    expect(reads).toBe(quietAfter) // after four stale reads and one clean one,
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true, complete: true }) // coverage fresh.
  } finally { loader.dispose(); childStores.disposeAll() }
})
