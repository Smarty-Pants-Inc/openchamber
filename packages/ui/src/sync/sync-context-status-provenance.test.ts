import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { AssistantMessage, Event, Session, ToolPart } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { opencodeClient } from "@/lib/opencode/client"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { applyDirectoryEvent } from "./event-reducer"
import { applyGlobalSessionStatusEvent, applyGlobalSessionStatusSnapshot, replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from "./global-session-status"
import { resetSessionActivityTiming, useSessionActivityTimingStore } from "./session-activity-timing"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"
import type { SessionStatus } from "./session-status"
import { getAllSyncSessions } from "./sync-refs"
import { resyncDirectorySessionStatuses } from "./sync-context"

const A = "/regression-1115/owner", B = "/regression-1115/foreign"
type Snapshot = NonNullable<Awaited<ReturnType<typeof opencodeClient.getSessionStatusForDirectory>>>
const busy: SessionStatus = { type: "busy" }, idle: SessionStatus = { type: "idle" }
const retry: SessionStatus = { type: "retry", attempt: 2, message: "waiting", next: 10 }
const ordinary: SessionStatus = { type: "busy", ordinary: true, ordinaryTarget: { generation: "1115", presentationId: "owner" } }
const session = (id: string, directory = A): Session => ({ id, directory, slug: id, projectID: "1115", title: id, version: "1", time: { created: 1, updated: 1 } })
const managers: ChildStoreManager[] = [], spies: { mockRestore(): void }[] = []
let catalogBefore = false
beforeEach(() => {
  catalogBefore = useProjectsStore.getState().managedCatalogAdmitted
  useProjectsStore.setState({ managedCatalogAdmitted: false })
  replaceGlobalSessionStatusById(new Map()); resetSessionOrdering(); resetSessionActivityTiming()
})
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore()); managers.splice(0).forEach((manager) => manager.disposeAll())
  useProjectsStore.setState({ managedCatalogAdmitted: catalogBefore })
  replaceGlobalSessionStatusById(new Map()); resetSessionOrdering(); resetSessionActivityTiming()
}) // No runtime endpoint/auth or sync refs are changed by these tests.
function child(directory = A) {
  const manager = new ChildStoreManager(); managers.push(manager)
  manager.ensureChild(directory === A ? B : A, { bootstrap: false })
  return manager.ensureChild(directory, { bootstrap: false })
}
function seed(store: StoreApi<DirectoryStore>, id: string, status: SessionStatus) {
  const assistant: AssistantMessage = { id: `${id}-answer`, sessionID: id, role: "assistant", parentID: `${id}-user`, time: { created: 2 },
    modelID: "model", providerID: "provider", mode: "agent", agent: "agent", path: { cwd: A, root: A }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const tool: ToolPart = { id: `${id}-tool`, sessionID: id, messageID: assistant.id, type: "tool", callID: id, tool: "bash",
    state: { status: "running", input: {}, time: { start: 2 } } }
  store.setState({ session_status: { [id]: status }, message: { [id]: [
    { id: `${id}-user`, sessionID: id, role: "user", time: { created: 1 }, agent: "agent", model: { providerID: "provider", modelID: "model" } }, assistant,
  ] }, part: { [assistant.id]: [tool] } })
  applyGlobalSessionStatusSnapshot(A, { [id]: status }, [id])
}
function view(store: StoreApi<DirectoryStore>, id: string) {
  const state = store.getState(), global = useGlobalSessionStatusStore.getState()
  const tool = state.part[`${id}-answer`]?.[0], answer = state.message[id]?.[1]
  return { child: state.session_status[id], global: global.statusById.get(id), active: global.activeSessionIds.has(id),
    tool: tool?.type === "tool" ? tool.state.status : undefined, completed: answer?.role === "assistant" ? answer.time.completed : undefined }
}
function event(store: StoreApi<DirectoryStore>, id: string, status: SessionStatus) {
  const payload: Event = { id: `${id}-${status.type}`, type: "session.status", properties: { sessionID: id, status } }
  applyGlobalSessionStatusEvent(A, payload)
  store.setState((state) => {
    const draft = { ...state, session_status: { ...state.session_status } }
    applyDirectoryEvent(draft, payload); return draft
  })
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred is not initialized") }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function pendingRead(store: StoreApi<DirectoryStore>, candidate: string) {
  const entered = deferred<void>(), response = deferred<Snapshot>()
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (directory) => {
    if (directory === null) return {}
    entered.resolve(undefined); return response.promise
  }))
  return { entered: entered.promise, release: response.resolve, result: resyncDirectorySessionStatuses(A, store, [candidate], "authoritative") }
}
const lifecycle = (id: string) => ({ rank: useSessionOrderingStore.getState().rankById.get(id),
  start: useSessionActivityTimingStore.getState().startedAt.get(id), settled: useSessionActivityTimingStore.getState().settledMs.get(id) })

// #1115: transport status is not ownership, including IDs outside the candidate list.
for (const [label, foreign, candidate] of [["busy", busy, true], ["retry", retry, true], ["noncandidate busy", busy, false]] satisfies [string, SessionStatus, boolean][]) {
  test(`#1115 foreign ${label} then idle across two resyncs preserves ordinary owner and running turn`, async () => {
    const id = `1115-${label}`, store = child(B); seed(store, id, ordinary)
    expect(store.getState().session).toEqual([])
    expect(getAllSyncSessions().some((record) => record.id === id)).toBe(false)
    let snapshot: Snapshot = { [id]: foreign }
    spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => snapshot))
    await resyncDirectorySessionStatuses(B, store, candidate ? [id] : [], "authoritative")
    const first = view(store, id)
    snapshot = { [id]: idle }
    await resyncDirectorySessionStatuses(B, store, [id], "authoritative")
    const expected = { child: ordinary, global: { status: ordinary, directory: A }, active: true, tool: "running", completed: undefined }
    expect([first, view(store, id)]).toEqual([expected, expected])
  })
}
for (const [label, status, snapshot] of [["own ordinary explicit idle", ordinary, idle], ["managed absent", busy, undefined], ["managed explicit idle", busy, idle]] satisfies [string, SessionStatus, SessionStatus | undefined][]) {
  test(`#1115 control: ${label} settles the unfinished turn`, async () => {
    const id = `1115-control-${label}`, store = child(); seed(store, id, status)
    if (!status.ordinary) store.setState({ session: [session(id)] })
    spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => snapshot ? { [id]: snapshot } : {}))
    await resyncDirectorySessionStatuses(A, store, [id], "authoritative")
    const result = view(store, id)
    expect(result.child?.type).toBe("idle"); expect(result.global).toBeUndefined(); expect(result.active).toBe(false)
    expect(result.tool).not.toBe("running"); expect(result.completed).toBeDefined()
  })
}

// #1116: the barrier proves the read started before the event; no timer races.
for (const old of [busy, retry]) {
  test(`#1116 old explicit ${old.type} cannot undo a newer idle event or its ordering/timing`, async () => {
    const id = `1116-idle-${old.type}`, store = child(); store.setState({ session: [session(id)] }); event(store, id, busy)
    const pending = pendingRead(store, id); await pending.entered
    event(store, id, idle); const afterIdle = lifecycle(id)
    pending.release({ [id]: old }); await pending.result
    expect(afterIdle.start).toBeUndefined(); expect(afterIdle.settled).toBeDefined()
    expect({ child: store.getState().session_status[id], global: useGlobalSessionStatusStore.getState().statusById.get(id),
      active: useGlobalSessionStatusStore.getState().activeSessionIds.has(id), lifecycle: lifecycle(id) })
      .toEqual({ child: idle, global: undefined, active: false, lifecycle: afterIdle })
  })
}
test("#1116 omitted sibling starting during a single-candidate directory read stays busy in both stores", async () => {
  const id = "1116-candidate", sibling = "1116-new-sibling", store = child()
  store.setState({ session: [session(id), session(sibling)] })
  const pending = pendingRead(store, id); await pending.entered
  event(store, sibling, busy); const started = lifecycle(sibling)
  pending.release({}); await pending.result
  expect({ child: store.getState().session_status[sibling], global: useGlobalSessionStatusStore.getState().statusById.get(sibling),
    active: useGlobalSessionStatusStore.getState().activeSessionIds.has(sibling), lifecycle: lifecycle(sibling) })
    .toEqual({ child: busy, global: { status: busy, directory: A }, active: true, lifecycle: started })
})
test("#1116 control: unchanged empty directory response still clears a sibling already busy before the read", async () => {
  const id = "1116-old-candidate", sibling = "1116-old-sibling", store = child()
  store.setState({ session: [session(id), session(sibling)] }); event(store, sibling, busy)
  const pending = pendingRead(store, id); await pending.entered
  pending.release({}); await pending.result
  expect(useGlobalSessionStatusStore.getState().statusById.has(sibling)).toBe(false)
  expect(useGlobalSessionStatusStore.getState().activeSessionIds.has(sibling)).toBe(false)
})
test("#1129 empty single-candidate resync settles an old managed sibling's global lifecycle only", async () => {
  const id = "1129-ordinary", sibling = "1129-old-managed", store = child()
  seed(store, id, ordinary)
  store.setState({ session: [session(sibling)] }); event(store, sibling, busy)
  const ownerBefore = { view: view(store, id), lifecycle: lifecycle(id) }, siblingBefore = lifecycle(sibling)
  expect(siblingBefore.start).toBeDefined(); expect(siblingBefore.rank).toBeDefined()
  const pending = pendingRead(store, id); await pending.entered
  const childBefore = store.getState()
  pending.release({}); await pending.result

  expect({ view: view(store, id), lifecycle: lifecycle(id) }).toEqual(ownerBefore)
  expect(useGlobalSessionStatusStore.getState().statusById.has(sibling)).toBe(false)
  expect(useGlobalSessionStatusStore.getState().activeSessionIds.has(sibling)).toBe(false)
  const settled = lifecycle(sibling)
  expect(settled.start).toBeUndefined(); expect(settled.settled).toBeDefined()
  expect(settled.rank).toBeGreaterThan(siblingBefore.rank ?? 0)
  expect(store.getState().session_status[sibling]).toEqual(busy)
  expect(store.getState().session_status).toBe(childBefore.session_status)
  expect(store.getState().message).toBe(childBefore.message); expect(store.getState().part).toBe(childBefore.part)

  const globalAfter = useGlobalSessionStatusStore.getState(), orderingAfter = useSessionOrderingStore.getState()
  const timingAfter = useSessionActivityTimingStore.getState()
  await resyncDirectorySessionStatuses(A, store, [id], "authoritative")
  expect(lifecycle(sibling)).toEqual(settled)
  expect(useGlobalSessionStatusStore.getState()).toBe(globalAfter)
  expect(useSessionOrderingStore.getState()).toBe(orderingAfter)
  expect(useSessionActivityTimingStore.getState()).toBe(timingAfter)
})
test("#1116 control: current explicit active snapshots publish candidates and raw siblings", async () => {
  const id = "1116-current", sibling = "1116-current-sibling", store = child()
  const pending = pendingRead(store, id); await pending.entered
  pending.release({ [id]: busy, [sibling]: retry }); await pending.result
  expect(store.getState().session_status[id]).toEqual(busy)
  expect(useGlobalSessionStatusStore.getState().statusById.get(id)).toEqual({ status: busy, directory: A })
  expect(useGlobalSessionStatusStore.getState().statusById.get(sibling)).toEqual({ status: retry, directory: A })
  expect([id, sibling].map((key) => useGlobalSessionStatusStore.getState().activeSessionIds.has(key))).toEqual([true, true])
})
test("#1116 newer deletion while already status-absent prevents old busy resurrection", async () => {
  const id = "1116-deleted", store = child(); store.setState({ session: [session(id)] })
  const pending = pendingRead(store, id); await pending.entered
  const payload: Event = { id: `${id}-delete`, type: "session.deleted", properties: { sessionID: id, info: session(id) } }
  applyGlobalSessionStatusEvent(A, payload)
  store.setState((state) => {
    const draft = { ...state, session: [...state.session], session_status: { ...state.session_status }, session_diff: { ...state.session_diff },
      todo: { ...state.todo }, message: { ...state.message }, part: { ...state.part }, permission: { ...state.permission }, question: { ...state.question },
      sessionEventRevision: { ...state.sessionEventRevision }, sessionDeletedRevision: { ...state.sessionDeletedRevision } }
    applyDirectoryEvent(draft, payload); return draft
  })
  const deleted = lifecycle(id)
  pending.release({ [id]: busy }); await pending.result
  expect(store.getState().session.some((record) => record.id === id)).toBe(false)
  expect({ child: store.getState().session_status[id], global: useGlobalSessionStatusStore.getState().statusById.get(id),
    active: useGlobalSessionStatusStore.getState().activeSessionIds.has(id), lifecycle: lifecycle(id) })
    .toEqual({ child: undefined, global: undefined, active: false, lifecycle: deleted })
})
