import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { interruptedTurnToolParts } from "./sync-context"

// smarty-code#669 (3.40, org's session): the page missed a streamed reply's removal (its event stream was cut), so at
// idle it showed the saved reply and a cut-off copy marked "The running turn stopped before the next message was sent.".
const S = "ses_a"
const user = { id: "u1", sessionID: S, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }
const reply = (id: string, completed?: number) => ({ id, sessionID: S, role: "assistant", parentID: "u1", modelID: "m", providerID: "p",
  time: completed === undefined ? { created: 2 } : { created: 2, completed }, mode: "build", agent: "build", path: { cwd: "/a", root: "/a" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
const base = new ChildStoreManager().ensureChild("/a", { bootstrap: false }).getState()
// SAFETY: fixture rows with the fields the settle path reads (role, time, id); the SDK's Message carries more.
const store = (ordinary: boolean, messages: object[]): DirectoryStore => ({ ...base,
  session_status: { [S]: ordinary ? { type: "idle", ordinary: true, ordinaryTarget: null } : { type: "idle" } },
  message: { [S]: messages as Message[] } })

test("#669: at an ordinary session's idle, a streamed copy that outlived its removal is dropped, not marked stopped", () => {
  const settled = interruptedTurnToolParts(store(true, [user, reply("a1", 3), reply("live_1")]), S)
  expect(settled?.dropped).toBe(true)
  expect(settled?.messages.map((m) => m.id)).toEqual(["u1", "a1"]) // One copy, no stop line.
})

test("#669: an older missed copy is dropped even when a later reply exists (Astra r1)", () => {
  const settled = interruptedTurnToolParts(store(true, [user, reply("a1", 3), reply("live_a"), reply("b1", 5)]), S)
  expect(settled?.messages.map((m) => m.id)).toEqual(["u1", "a1", "b1"])
})

test("#669: several missed copies in one turn are all dropped at once (Astra r1)", () => {
  const settled = interruptedTurnToolParts(store(true, [user, reply("a1", 3), reply("live_a"), reply("b1", 5), reply("live_b")]), S)
  expect(settled?.messages.map((m) => m.id)).toEqual(["u1", "a1", "b1"])
})

test("#669 counterexample: a non-ordinary (OpenCode) turn left unfinished by a crash is still marked stopped", () => {
  const settled = interruptedTurnToolParts(store(false, [user, reply("a1")]), S)
  expect(settled?.dropped).toBeUndefined()
  const last = settled?.messages.at(-1)
  expect(last?.role === "assistant" ? last.error?.name : undefined).toBe("MessageAbortedError")
})

test("#669 counterexample: an ordinary session's saved reply is left as it is", () => {
  expect(interruptedTurnToolParts(store(true, [user, reply("a1", 3)]), S)).toBeNull()
})

