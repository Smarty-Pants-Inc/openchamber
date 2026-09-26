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
