import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from "../global-session-status"
import { useNotificationStore } from "../notification-store"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import type { OrdinaryModelState } from "@/lib/opencode/ordinaryModel"

// Managed unopened projects retain unread alerts without creating a directory store.
// Stock unopened directories retain the fork's silent baseline; routing still applies.

const session = (id: string, directory: string, parentID?: string): Session => {
  const record: Session = {
    id, slug: id, directory, projectID: "project", title: id, version: "1",
    time: { created: 1, updated: 1 },
  }
  if (parentID) record.parentID = parentID
  return record
}

const resetNotifications = () => {
  useNotificationStore.setState({
    list: [],
    index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } },
  })
}

describe("events for directories without a store", () => {
  let childStores: ChildStoreManager
  const initialProjects = useProjectsStore.getState()

  beforeEach(() => {
    childStores = new ChildStoreManager()
    useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' })
    childStores.ensureChild("/open", { bootstrap: false })
    useGlobalSessionsStore.getState().applySnapshot([
      session("ses_far", "/far"),
      session("ses_far_child", "/far", "ses_far"),
    ], [], "ready")
    resetNotifications()
    replaceGlobalSessionStatusById(new Map())
  })

  afterEach(() => {
    childStores.disposeAll()
    useProjectsStore.setState(initialProjects, true)
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    resetNotifications()
    replaceGlobalSessionStatusById(new Map())
  })

  test("a stock turn finishing or failing in an unopened directory remains silent", () => {
    const routingIndex = createEventRoutingIndex()
    const idle: Event = { id: "e1", type: "session.idle", properties: { sessionID: "ses_far" } }
    const error: Event = {
      id: "e2", type: "session.error",
      properties: { sessionID: "ses_far", error: { name: "UnknownError", data: { message: "boom" } } },
    }

    handleEvent("/far", idle, childStores, routingIndex, getRuntimeKey())
    handleEvent("/far", error, childStores, routingIndex, getRuntimeKey())

    const index = useNotificationStore.getState().index
    expect(useNotificationStore.getState().list).toEqual([])
    expect(index.session.unseenCount.ses_far).toBeUndefined()
    expect(index.session.unseenHasError.ses_far).toBeUndefined()
    expect(index.project.unseenCount["/far"]).toBeUndefined()
    expect(childStores.getChild("/far")).toBeUndefined()
  })

  test("a managed native turn finishing or failing in an unopened directory records unread and error alerts", () => {
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready' })
    const nativeSession = {
      ...session("ses_far", "/far"),
      ordinary: {
        generation: "generation", sequence: 0,
        model: { providerID: "fixture", modelID: "native", name: "Native" }, thinkingLevel: "high",
      },
    } satisfies Session & { ordinary: OrdinaryModelState }
    useGlobalSessionsStore.getState().applySnapshot([
      nativeSession,
      session("ses_far_child", "/far", "ses_far"),
    ], [], "ready")
    const routingIndex = createEventRoutingIndex()
    handleEvent("/far", { id: "managed-idle", type: "session.idle", properties: { sessionID: "ses_far" } },
      childStores, routingIndex, getRuntimeKey())
    handleEvent("/far", {
      id: "managed-error", type: "session.error",
      properties: { sessionID: "ses_far", error: { name: "UnknownError", data: { message: "boom" } } },
    }, childStores, routingIndex, getRuntimeKey())

    const index = useNotificationStore.getState().index
    expect(index.session.unseenCount.ses_far).toBe(2)
    expect(index.session.unseenHasError.ses_far).toBe(true)
    expect(index.project.unseenCount["/far"]).toBe(2)
    expect(childStores.getChild("/far")).toBeUndefined()
  })

  test("a subtask finishing in an unopened directory is not a notification", () => {
    const routingIndex = createEventRoutingIndex()
    handleEvent("/far", { id: "e1", type: "session.idle", properties: { sessionID: "ses_far_child" } },
      childStores, routingIndex, getRuntimeKey())

    expect(useNotificationStore.getState().list).toEqual([])
  })

  test("a directory-less status event for a cached session is not filed into the only open store", () => {
    const routingIndex = createEventRoutingIndex()
    const open = childStores.getChild("/open")!
    handleEvent("global", { id: "e1", type: "session.status", properties: { sessionID: "ses_far", status: { type: "busy" } } },
      childStores, routingIndex, getRuntimeKey())

    expect(open.getState().session_status.ses_far).toBeUndefined()
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_far")).toEqual({ status: { type: "busy" }, directory: "/far" })
  })

  test("a directory-less event for an unknown session still uses the single-store fallback", () => {
    const routingIndex = createEventRoutingIndex()
    const open = childStores.getChild("/open")!
    handleEvent("global", { id: "e1", type: "session.status", properties: { sessionID: "ses_new", status: { type: "busy" } } },
      childStores, routingIndex, getRuntimeKey())

    expect(open.getState().session_status.ses_new).toEqual({ type: "busy" })
  })
})
