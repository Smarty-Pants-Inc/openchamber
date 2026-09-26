import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { ChildStoreManager } from "../child-store"
import { useNotificationStore } from "../notification-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

// smarty-code G13: a managed catalog bootstraps only the selected project, so another project has no child store.
// Its sessions' completions and errors still alert (unread counts), with the catalog's global session list deciding
// top level vs subtask.
const other = "/fleet/other"
const session = (id: string, parentID?: string) =>
  ({ id, directory: other, projectID: "p", slug: id, title: id, version: "1", time: { created: 1, updated: 1 }, ...(parentID ? { parentID } : {}) }) as Session
let children: ChildStoreManager
const initialProjects = useProjectsStore.getState(), initialGlobal = useGlobalSessionsStore.getState()
beforeEach(() => {
  children = new ChildStoreManager()
  useNotificationStore.setState(useNotificationStore.getInitialState())
  useGlobalSessionsStore.getState().applySnapshot([session("ses_top"), session("ses_sub", "ses_top")], [])
})
afterEach(() => { children.disposeAll(); useProjectsStore.setState(initialProjects, true); useGlobalSessionsStore.setState(initialGlobal, true) })
const idle = (sessionID: string) => ({ type: "session.idle", properties: { sessionID } }) as unknown as Event
const alerted = () => useNotificationStore.getState().list.map(entry => entry.session)

test("managed: a top-level session in an unloaded project alerts; its subtask and an unknown session do not", () => {
  useProjectsStore.setState({ managedCatalogAdmitted: true })
  for (const id of ["ses_top", "ses_sub", "ses_unknown"]) handleEvent(other, idle(id), children, createEventRoutingIndex(), getRuntimeKey())
  expect(alerted()).toEqual(["ses_top"])
  expect(children.getChild(other)).toBeUndefined() // Still no bootstrap for that project.
})

test("stock: an event for a directory with no store is unchanged (no alert)", () => {
  useProjectsStore.setState({ managedCatalogAdmitted: false })
  handleEvent(other, idle("ses_top"), children, createEventRoutingIndex(), getRuntimeKey())
  expect(alerted()).toEqual([])
})

test("managed: a session announced and finished in the same flush (not yet published) still alerts; its subtask does not", () => {
  useProjectsStore.setState({ managedCatalogAdmitted: true })
  const batch: NonNullable<Parameters<typeof handleEvent>[7]> = { states: new Map(), clonedFields: new Map(), changedStores: new Set(),
    globalSessionEvents: [], globalStatusEventsByDirectory: new Map() }
  const created = (info: Session) => ({ type: "session.created", properties: { info } }) as unknown as Event
  const error = (sessionID: string) => ({ type: "session.error", properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } } }) as unknown as Event
  for (const event of [created(session("ses_new")), idle("ses_new"), created(session("ses_new_sub", "ses_new")), error("ses_new_sub")]) {
    handleEvent(other, event, children, createEventRoutingIndex(), getRuntimeKey(), false, undefined, batch)
  }
  expect(alerted()).toEqual(["ses_new"])
})
