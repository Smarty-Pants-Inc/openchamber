import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import type { ProjectEntry } from "@/lib/api/types"

// Run in its own process (CI's isolated runner): the module mock is this file's.
// smarty-dev#777 (#282 review): a project that joins the open event stream refreshes the managed catalog, through the
// real handleEvent. That includes a project that comes BACK (removed, then re-added) while this page still caches
// its child store: the event then routes to that store, and must still refresh the catalog.
let refreshes = 0
mock.module("@/lib/managed-project-refresh", () => ({ refreshManagedProjects: async () => { refreshes++ } }))
const { JOIN_DEBOUNCE_MS } = await import("@/lib/managed-project-join")
const { getRuntimeKey } = await import("@/lib/runtime-switch")
const { useProjectsStore } = await import("@/stores/useProjectsStore")
const { ChildStoreManager } = await import("../child-store")
const { createEventRoutingIndex, handleEvent } = await import("../sync-context")

const back = "/fleet/back"
const listed = (...paths: string[]): ProjectEntry[] => paths.map(path => ({ id: path, path, label: path }))
const connected: Event = { id: "evt-connected", type: "server.connected", properties: {} }
const settle = () => new Promise(resolve => setTimeout(resolve, JOIN_DEBOUNCE_MS + 50))
let children: InstanceType<typeof ChildStoreManager>
const initial = useProjectsStore.getState()
beforeEach(() => {
  refreshes = 0; children = new ChildStoreManager()
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: "ready", managedProjects: listed("/fleet/a") })
})
afterEach(() => { children.disposeAll(); useProjectsStore.setState(initial, true) })

test("a project re-added while its child store is still cached refreshes the catalog once", async () => {
  children.ensureChild(back, { bootstrap: false }) // Opened earlier, then removed from the catalog: its store stays cached.
  handleEvent(back, connected, children, createEventRoutingIndex(), getRuntimeKey())
  await settle()
  expect(refreshes).toBe(1)
})

test("a new project without a store refreshes the catalog once; a listed project with a store refreshes nothing", async () => {
  handleEvent("/fleet/new", connected, children, createEventRoutingIndex(), getRuntimeKey())
  await settle()
  expect(refreshes).toBe(1)
  children.ensureChild("/fleet/a", { bootstrap: false })
  handleEvent("/fleet/a", connected, children, createEventRoutingIndex(), getRuntimeKey())
  await settle()
  expect(refreshes).toBe(1)
})
