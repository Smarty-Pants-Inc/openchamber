import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { interruptedTurnToolParts, settledBySnapshot } from "./sync-context"

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

// smarty-code#737 (3.41, 06:54:52Z): one authoritative /session/status read omitted three busy fleet sessions, and the
// page marked their running tools Interrupted; each tool's result was committed seconds later.
test("#737: an ordinary session absent from an authoritative snapshot is not settled; an explicit idle is", () => {
  const ordinary = { type: "idle" as const, ordinary: true, ordinaryTarget: null }
  expect(settledBySnapshot(undefined, ordinary)).toBe(false) // Absent: not known to have stopped.
  expect(settledBySnapshot({ type: "idle" }, ordinary)).toBe(true) // Explicit idle settles it.
})

test("#737 counterexample: a non-ordinary session absent from the snapshot is still settled (#2577)", () => {
  const managed = { id: S } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot(undefined, { type: "idle" }, managed)).toBe(true)
  expect(settledBySnapshot(undefined, undefined, managed)).toBe(true)
})

test("#737 review: a fleet session whose status lost its ordinary mark is known by its session metadata, not settled", () => {
  const fleetSession = { id: S, nativeRuntime: "ordinary" } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot(undefined, { type: "idle" }, fleetSession)).toBe(false) // The incident: status not marked ordinary.
  expect(settledBySnapshot({ type: "idle" }, { type: "idle" }, fleetSession)).toBe(true) // Explicit idle still settles.
  const managed = { id: S } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot(undefined, { type: "idle" }, managed)).toBe(true) // A managed session keeps #2577's rule.
})

// smarty-code#737, the real cause (the service journal at 06:54:48-52Z): a worktree was added to the catalog, the page read
// ITS status, and that directory's store held messages of three fleet sessions of other projects: their absence from
// that directory's snapshot was taken as idle.
test("#737: a session of another directory is never settled by this directory's snapshot", () => {
  const other = { id: S, directory: "/fleet/org/" } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot(undefined, { type: "idle" }, other, "/projects/p608-966439-1")).toBe(false)
  const own = { id: S, directory: "/projects/p608-966439-1/" } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot(undefined, { type: "idle" }, own, "/projects/p608-966439-1")).toBe(true) // Its own: #2577.
  expect(settledBySnapshot({ type: "idle" }, { type: "idle" }, other, "/projects/p608-966439-1")).toBe(true) // Listed: settles.
})

// 3.57 (04:53:48Z): net-lead's running tool was marked Interrupted by an authoritative snapshot on Code Test 5's page
// while its Pi kept working (the next tool ran 04:53:48.974-55.760). The page's status carried no ordinary mark.
test("3.57 #737: another directory's explicit idle never settles a fleet session; an unknown session is never settled", () => {
  const fleet = { id: S, directory: "/p/smarty-net", nativeRuntime: "ordinary" } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot({ type: "idle" }, { type: "idle" }, fleet, "/p/smarty-net/pages-ux")).toBe(false) // (a)
  expect(settledBySnapshot(undefined, { type: "idle" }, undefined, "/p/smarty-net/pages-ux")).toBe(false) // (b)
  expect(settledBySnapshot({ type: "idle" }, { type: "idle" }, fleet, "/p/smarty-net/")).toBe(true) // Its own directory: settles.
  const managed = { id: S, directory: "/p/other" } as unknown as Parameters<typeof settledBySnapshot>[2]
  expect(settledBySnapshot({ type: "idle" }, { type: "idle" }, managed, "/p/smarty-net")).toBe(true) // A managed session keeps its rule.
})
