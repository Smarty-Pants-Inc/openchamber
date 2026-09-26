import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { toast } from "@/components/ui"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "../child-store"
import { reloadSteerOutcomesForTest, useSteerOutcomes } from "../steer-outcomes"
import { registerPendingSteer, reloadPendingSteersForTest, takePendingSteer } from "../pending-steers"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "../session-message-loader"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

// Co-steer (MVP 1 G5): what finally became of a steered message arrives as smarty.prompt.outcome on the session's stream.
const directory = "/repo"
const sessionID = "ses_org"
const memory = new Map<string, string>()
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) },
  removeItem: (key: string) => { memory.delete(key) }, clear: () => memory.clear(), key: () => null, length: 0,
} satisfies Storage })

let children: ChildStoreManager
let loader: SessionMessageLoader
const toasts: string[] = []
const newLoader = () => {
  loader?.dispose()
  loader = new SessionMessageLoader(children, { sdk: createOpencodeClient({ baseUrl: "http://opencode.test" }), runtimeKey: getRuntimeKey() })
  setImperativeSessionMessageLoader(loader)
}

beforeEach(() => {
  memory.clear()
  reloadPendingSteersForTest()
  children = new ChildStoreManager()
  children.ensureChild(directory, { bootstrap: false }).setState({ session: [{ id: sessionID, directory } as never] })
  newLoader()
  reloadSteerOutcomesForTest()
  toasts.length = 0
  spyOn(toast, "error").mockImplementation(message => { toasts.push(String(message)); return "toast" })
})
afterEach(() => { setImperativeSessionMessageLoader(null); loader.dispose(); children.disposeAll() })

const sent = (messageID: string, text: string) => {
  registerPendingSteer({ runtimeKey: getRuntimeKey(), directory, sessionID, messageID, text })
  loader.optimisticAdd({ directory, sessionID, message: { id: messageID, role: "user", sessionID, time: { created: 1 } } as unknown as Message,
    parts: [{ id: `prt_${messageID}`, messageID, sessionID, type: "text", text } as Part] })
}
// The event carries no directory ("global"): it is settled by session and message ID.
const outcomeEvent = (messageID: string, outcome: string) =>
  ({ type: "smarty.prompt.outcome", properties: { sessionID, messageID, outcome } }) as unknown as Event
const deliver = async (messageID: string, outcome: string) => {
  handleEvent("global", outcomeEvent(messageID, outcome), children, createEventRoutingIndex(), getRuntimeKey())
  await Promise.resolve()
}
const shown = () => (children.getChild(directory)?.getState().message[sessionID] ?? []).map(message => message.id)
const notices = () => useSteerOutcomes.getState().items.map(item => `${item.outcome}: ${item.text}`)

test("not delivered: the sender's copy goes and the sender is told, with the text to send again", async () => {
  sent("msg_kate", "draft a marketing plan")
  await deliver("msg_kate", "not-delivered")
  expect(shown()).toEqual([])
  expect(toasts).toHaveLength(1)
  expect(toasts[0].startsWith("Not delivered:")).toBe(true)
  expect(toasts[0]).toContain("draft a marketing plan")
  expect(notices()).toEqual(["not-delivered: draft a marketing plan"])
  expect(takePendingSteer(getRuntimeKey(), sessionID, "msg_kate")).toBeUndefined()
})

test("unconfirmed: the copy bound to no entry goes, and the sender is told to check the session", async () => {
  sent("msg_kate", "what changed today?")
  await deliver("msg_kate", "unconfirmed")
  expect(shown()).toEqual([])
  expect(toasts[0].startsWith("Not confirmed:")).toBe(true)
  expect(toasts[0]).toContain("what changed today?")
})

test("delivered: the record is settled and the page's copy stays for the server's entry to replace", async () => {
  sent("msg_kate", "hello")
  await deliver("msg_kate", "delivered")
  expect(shown()).toEqual(["msg_kate"])
  expect(toasts).toHaveLength(0)
  expect(takePendingSteer(getRuntimeKey(), sessionID, "msg_kate")).toBeUndefined()
})

test("another tab's message, an unknown outcome or a malformed event does nothing here", async () => {
  sent("msg_mine", "mine")
  await deliver("msg_paul", "not-delivered")
  await deliver("msg_mine", "lost")
  handleEvent("global", { type: "smarty.prompt.outcome", properties: { sessionID, outcome: "not-delivered" } } as unknown as Event,
    children, createEventRoutingIndex(), getRuntimeKey())
  await Promise.resolve()
  expect(shown()).toEqual(["msg_mine"])
  expect(toasts).toHaveLength(0)
})

test("after a reload (the transcript cache lost its copy), the sender is still told", async () => {
  sent("msg_kate", "draft a marketing plan")
  loader.invalidateSession({ directory, sessionID })
  newLoader()
  reloadPendingSteersForTest() // The page's memory is gone; the record comes back from sessionStorage.
  await deliver("msg_kate", "not-delivered")
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain("draft a marketing plan")
})

test("an outcome after session.idle in one event batch does not bring the copy back", async () => {
  sent("msg_kate", "draft a marketing plan")
  const batch = { states: new Map(), clonedFields: new Map(), changedStores: new Set(), globalSessionEvents: [],
    globalStatusEventsByDirectory: new Map() }
  const index = createEventRoutingIndex()
  handleEvent(directory, { type: "session.idle", properties: { sessionID } } as Event, children, index, getRuntimeKey(), false, undefined, batch as never)
  handleEvent(directory, outcomeEvent("msg_kate", "not-delivered"), children, index, getRuntimeKey(), false, undefined, batch as never)
  // The pipeline's own publish step, as in onEvents' finally.
  for (const store of batch.changedStores as Set<{ setState: (state: unknown) => void }>) store.setState(batch.states.get(store))
  await Promise.resolve()
  expect(shown()).toEqual([])
})

test("delivered retires the page's shadow copy, so a later refresh cannot restore it", async () => {
  sent("msg_kate", "hello")
  const confirm = spyOn(loader, "optimisticConfirm")
  await deliver("msg_kate", "delivered")
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(confirm.mock.calls[0][0]).toMatchObject({ directory, sessionID, messageID: "msg_kate" })
})

test("an outcome from another runtime's stream, or one whose loader was replaced meanwhile, touches nothing here", async () => {
  sent("msg_kate", "hello")
  handleEvent("global", outcomeEvent("msg_kate", "not-delivered"), children, createEventRoutingIndex(), "url:https://other.invalid")
  await Promise.resolve()
  expect(toasts).toHaveLength(0)
  expect(shown()).toEqual(["msg_kate"])
  // Same runtime, but the provider installed a new loader before the deferred removal ran.
  const old = loader
  handleEvent("global", outcomeEvent("msg_kate", "not-delivered"), children, createEventRoutingIndex(), getRuntimeKey())
  const removeOld = spyOn(old, "optimisticRemove")
  newLoader()
  const removeNew = spyOn(loader, "optimisticRemove")
  await Promise.resolve()
  expect(removeOld).not.toHaveBeenCalled()
  expect(removeNew).not.toHaveBeenCalled()
  expect(toasts).toHaveLength(1)
})

test("a full or blocked sessionStorage does not stop a live outcome", async () => {
  const setItem = spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError") })
  try {
    sent("msg_kate", "draft a marketing plan")
    await deliver("msg_kate", "not-delivered")
    expect(toasts).toHaveLength(1)
    expect(shown()).toEqual([])
  } finally { setItem.mockRestore() }
})

test("a second send that reuses a pending message ID does not own it", () => {
  const record = { runtimeKey: getRuntimeKey(), directory, sessionID, messageID: "msg_kate", text: "first" }
  expect(registerPendingSteer(record)).toBe(true)
  expect(registerPendingSteer({ ...record, text: "second" })).toBe(false)
  expect(takePendingSteer(getRuntimeKey(), sessionID, "msg_kate")?.text).toBe("first")
})

// smarty-code#399 review (finding 3): the gateway may correct an outcome it already sent, keyed by the same sessionID
// and messageID. A later 'delivered' clears the sender's failure notice; a different failure replaces its wording.
test("a failure later corrected to delivered clears the sender's notice", async () => {
  sent("msg_kate", "draft a marketing plan")
  await deliver("msg_kate", "not-delivered")
  expect(notices()).toEqual(["not-delivered: draft a marketing plan"])
  await deliver("msg_kate", "delivered")
  expect(notices()).toEqual([])
})

test("an unconfirmed outcome later corrected to not-delivered replaces the notice; a repeat changes nothing", async () => {
  sent("msg_kate", "what changed today?")
  await deliver("msg_kate", "unconfirmed")
  await deliver("msg_kate", "not-delivered")
  expect(notices()).toEqual(["not-delivered: what changed today?"])
  await deliver("msg_kate", "not-delivered")
  expect(notices()).toEqual(["not-delivered: what changed today?"])
  expect(toasts).toHaveLength(1)
})

test("a correction for another message or another tab's message touches nothing", async () => {
  sent("msg_kate", "first")
  await deliver("msg_kate", "not-delivered")
  await deliver("msg_other", "delivered")
  expect(notices()).toEqual(["not-delivered: first"])
})

test("a delivered correction in the same batch keeps the message, and one after the removal reads the tail again", async () => {
  sent("msg_kate", "draft a marketing plan")
  const tail = spyOn(loader, "refreshTail").mockResolvedValue(undefined)
  // Same batch: the failure schedules the removal, the correction arrives before it runs.
  handleEvent("global", outcomeEvent("msg_kate", "unconfirmed"), children, createEventRoutingIndex(), getRuntimeKey())
  handleEvent("global", outcomeEvent("msg_kate", "delivered"), children, createEventRoutingIndex(), getRuntimeKey())
  await Promise.resolve()
  expect(shown()).toEqual(["msg_kate"])
  expect(notices()).toEqual([])
  // Later: the failure already removed the copy; the correction reads the session's tail so the message shows again.
  sent("msg_two", "second")
  await deliver("msg_two", "not-delivered")
  expect(shown()).not.toContain("msg_two")
  await deliver("msg_two", "delivered")
  expect(tail).toHaveBeenCalledWith({ directory, sessionID }, 50)
  tail.mockRestore()
})

test("a delivered correction after the person dismissed the failure notice still restores the message", async () => {
  sent("msg_dismissed", "dismissed then delivered")
  const tail = spyOn(loader, "refreshTail").mockResolvedValue(undefined)
  await deliver("msg_dismissed", "unconfirmed")
  useSteerOutcomes.getState().dismiss(getRuntimeKey(), "msg_dismissed")
  await deliver("msg_dismissed", "delivered")
  expect(tail).toHaveBeenCalledWith({ directory, sessionID }, 50)
  tail.mockRestore()
})

test("a delivered correction retires the page's shadow so a later authoritative removal stays removed", async () => {
  sent("msg_shadow", "shadowed")
  const tail = spyOn(loader, "refreshTail").mockResolvedValue(undefined)
  const confirm = spyOn(loader, "optimisticConfirm")
  handleEvent("global", outcomeEvent("msg_shadow", "unconfirmed"), children, createEventRoutingIndex(), getRuntimeKey())
  handleEvent("global", outcomeEvent("msg_shadow", "delivered"), children, createEventRoutingIndex(), getRuntimeKey())
  await Promise.resolve(); await Promise.resolve()
  expect(confirm).toHaveBeenCalledWith({ directory, sessionID, messageID: "msg_shadow" })
  tail.mockRestore(); confirm.mockRestore()
})
