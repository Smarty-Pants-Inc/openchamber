import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async () => []),
    listPendingPermissions: mock(async () => []),
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({ setSessionTodos: () => undefined }) },
}))

mock.module("sonner", () => ({
  toast: {
    dismiss: () => undefined,
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

import { ChildStoreManager } from "../child-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getSessionMaterializationStatus } from "../materialization"
const { createEventRoutingIndex, handleEvent, setActiveSession, setExternallyViewedSession } = await import("../sync-context")

// smarty-code#682: a tab showing ONE session received ~57 events/s of OTHER sessions' message traffic (served 3.60), and
// applying them (store copies, then renders) kept its main thread ~75% busy, so its own streaming text lagged. The page
// now drops message.updated / message.part.updated for sessions it does not show, BEFORE the reducers.
const DIR = "/repo"
const msg = (sessionID: string, id: string) => ({ type: "message.updated", properties: { info: { id, sessionID, role: "assistant", time: { created: 1 } } } }) as unknown as Event
const part = (sessionID: string, messageID: string, text: string) => ({ type: "message.part.updated",
  properties: { sessionID, part: { id: `prt_${messageID}`, sessionID, messageID, type: "text", text } } }) as unknown as Event
const status = (sessionID: string) => ({ type: "session.status", properties: { sessionID, status: { type: "busy" } } }) as unknown as Event
const setup = (sessions: Array<{ id: string; parentID?: string }> = []) => {
  const childStores = new ChildStoreManager(), routing = createEventRoutingIndex()
  const store = childStores.ensureChild(DIR, { bootstrap: false })
  store.setState({ ...store.getState(), status: "complete", session: sessions.map((s) => ({ id: s.id, parentID: s.parentID, directory: DIR, time: { created: 1, updated: 1 } })) } as never)
  const send = (e: Event) => handleEvent(DIR, e, childStores, routing, getRuntimeKey())
  return { store, send }
}

describe("#682: other sessions' message traffic is not applied", () => {
  beforeEach(() => { setActiveSession("", ""); setExternallyViewedSession(DIR, "ses_ext", false) })

  test("a hidden session's message and part updates are dropped; the shown session's are applied", () => {
    const { store, send } = setup([{ id: "ses_shown" }, { id: "ses_other" }])
    setActiveSession(DIR, "ses_shown")
    send(msg("ses_other", "msg_o1")); send(part("ses_other", "msg_o1", "not shown"))
    send(msg("ses_shown", "msg_s1")); send(part("ses_shown", "msg_s1", "shown text"))
    const s = store.getState()
    expect(s.message["ses_other"]).toBe(undefined)
    expect(s.part["msg_o1"]).toBe(undefined)
    expect(s.message["ses_shown"]?.map((m) => m.id)).toEqual(["msg_s1"])
    expect((s.part["msg_s1"]?.[0] as { text?: string })?.text).toBe("shown text")
  })

  test("a hidden session's cached history is evicted at its first dropped update, so its next open loads fresh (no stale parts)", () => {
    const { store, send } = setup([{ id: "ses_a" }, { id: "ses_b" }])
    setActiveSession(DIR, "ses_b")
    send(msg("ses_b", "msg_b1")); send(part("ses_b", "msg_b1", "old text"))
    expect(getSessionMaterializationStatus(store.getState(), "ses_b").renderable).toBe(true)
    setActiveSession(DIR, "ses_a") // the person switches away; b keeps streaming
    send(part("ses_b", "msg_b1", "old text and more"))
    const s = store.getState()
    expect(s.message["ses_b"]).toBe(undefined); expect(s.part["msg_b1"]).toBe(undefined)
    // Nothing renderable: opening b again takes the loader's fresh initial load, not the cached, stale copy.
    expect(getSessionMaterializationStatus(s, "ses_b").renderable).toBe(false)
  })

  test("a hidden session's status is still applied (the sidebar needs it)", () => {
    const { store, send } = setup([{ id: "ses_shown" }, { id: "ses_other" }])
    setActiveSession(DIR, "ses_shown")
    send(status("ses_other"))
    expect((store.getState().session_status as Record<string, { type: string }>)["ses_other"]?.type).toBe("busy")
  })

  test("a child of the shown session (its subagent's output shows in the parent) and an externally viewed session are applied", () => {
    const { store, send } = setup([{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }, { id: "ses_ext" }])
    setActiveSession(DIR, "ses_parent"); setExternallyViewedSession(DIR, "ses_ext", true)
    send(msg("ses_child", "msg_c1")); send(msg("ses_ext", "msg_e1"))
    const s = store.getState()
    expect(s.message["ses_child"]?.map((m) => m.id)).toEqual(["msg_c1"])
    expect(s.message["ses_ext"]?.map((m) => m.id)).toEqual(["msg_e1"])
  })

  test("with no shown session (no session open), nothing is dropped", () => {
    const { store, send } = setup([{ id: "ses_x" }])
    send(msg("ses_x", "msg_x1"))
    expect(store.getState().message["ses_x"]?.map((m) => m.id)).toEqual(["msg_x1"])
  })
})
