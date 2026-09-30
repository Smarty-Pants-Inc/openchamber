import { afterEach, expect, spyOn, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { resyncDirectorySessionStatuses, snapshotVerdict } from "./sync-context"
import { applyGlobalSessionStatusSnapshot, replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from "./global-session-status"
import { opencodeClient } from "@/lib/opencode/client"
import { useProjectsStore } from "@/stores/useProjectsStore"

// smarty-code#737: which sessions a directory's AUTHORITATIVE /session/status snapshot may lower and settle.
const S = "01a0cdaa-ad68-72f2-ae87-296cef1670fc", CODE = "/p/smarty-code", NET = "/p/smarty-net"
const busyOrdinary = { type: "busy", ordinary: true, ordinaryTarget: { generation: "g", presentationId: "p" } } as never
const fleetSession = { id: S, directory: NET, nativeRuntime: "ordinary" } as unknown as Session
const managed = (directory: string) => ({ id: S, directory }) as unknown as Session

test("verdicts: a fleet session is lowered only by an explicit status from its own known directory", () => {
  expect(snapshotVerdict({ type: "idle" }, NET, { session: fleetSession })).toBe("settle") // Own directory: settles.
  expect(snapshotVerdict({ type: "idle" }, CODE, { session: fleetSession })).toBe("hold") // Foreign idle.
  expect(snapshotVerdict({ type: "idle" }, CODE, { prior: busyOrdinary })).toBe("hold") // Review 2 #1: no record anywhere.
  expect(snapshotVerdict(undefined, CODE, { prior: busyOrdinary })).toBe("hold") // Absent.
  expect(snapshotVerdict(undefined, NET, { session: fleetSession })).toBe("hold") // Absent even from its own: never by absence.
})
test("verdicts: absence holds a session another source shows active or placed elsewhere; managed ones keep #2577", () => {
  expect(snapshotVerdict(undefined, CODE, { session: managed(CODE), fleet: { type: "busy" } })).toBe("hold") // 3.57 capture.
  expect(snapshotVerdict(undefined, CODE, { indexed: { status: { type: "busy" }, directory: NET } })).toBe("hold")
  expect(snapshotVerdict(undefined, CODE, { session: managed(NET) })).toBe("hold")
  expect(snapshotVerdict(undefined, CODE, { session: managed(CODE) })).toBe("settle") // Counterexample: #2577.
  expect(snapshotVerdict({ type: "idle" }, CODE, { session: managed(NET) })).toBe("settle") // A managed explicit idle settles.
  expect(snapshotVerdict(undefined, CODE, {})).toBe("lower") // Unknown: lowered, never settled.
})

// Full reconciliation (review 2 #1 + #2): the store holds net-lead ordinary-busy with a running tool and no session
// record; smarty-code's authoritative snapshot says (a) an unmarked explicit idle, or (b) nothing, while the fleet read
// says busy. Both stores keep busy/retry, the tool stays running, nothing is reported settled.
const running = (): { messages: Message[]; parts: Record<string, Part[]> } => ({
  messages: [{ id: "u1", sessionID: S, role: "user", time: { created: 1 } } as unknown as Message,
    { id: "a1", sessionID: S, role: "assistant", parentID: "u1", time: { created: 2 }, modelID: "m", providerID: "p", mode: "b", agent: "b",
      path: { cwd: NET, root: NET }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as unknown as Message],
  parts: { a1: [{ id: "t1", sessionID: S, messageID: "a1", type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: {}, time: { start: 2 } } } as unknown as Part] } })
const spies: { mockRestore: () => void }[] = []
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); replaceGlobalSessionStatusById(new Map()) })
async function reconcile(snapshot: Record<string, unknown>, fleet: Record<string, unknown>, managedCatalog = true) {
  const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
  const { messages, parts } = running()
  store.setState({ session_status: { [S]: busyOrdinary }, message: { [S]: messages }, part: parts })
  applyGlobalSessionStatusSnapshot(NET, { [S]: busyOrdinary }, [S])
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => (d ? snapshot : fleet) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: managedCatalog } as never)
  await resyncDirectorySessionStatuses(CODE, store, [S], "authoritative")
  const s = store.getState()
  return { child: s.session_status?.[S]?.type, global: useGlobalSessionStatusStore.getState().statusById.get(S)?.status.type,
    tool: (s.part.a1?.[0] as { state?: { status?: string } })?.state?.status, completed: (s.message[S]?.[1] as { time?: { completed?: number } })?.time?.completed }
}
test("reconciliation (a): a foreign unmarked idle for an ordinary-busy session with no record keeps both stores busy, the tool running", async () => {
  expect(await reconcile({ [S]: { type: "idle" } }, {})).toEqual({ child: "busy", global: "busy", tool: "running", completed: undefined })
})
test("reconciliation (b): absent here while the fleet says busy keeps both stores busy, the tool running", async () => {
  expect(await reconcile({}, { [S]: { type: "busy" } })).toEqual({ child: "busy", global: "busy", tool: "running", completed: undefined })
})
test("reconciliation counterexample: a managed session of this directory, absent, is settled (#2577)", async () => {
  const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
  const { messages, parts } = running()
  store.setState({ session: [managed(CODE)], session_status: { [S]: { type: "busy" } }, message: { [S]: messages }, part: parts })
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => ({}) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: false } as never)
  await resyncDirectorySessionStatuses(CODE, store, [S], "authoritative")
  expect(store.getState().session_status?.[S]?.type).toBe("idle")
  expect((store.getState().part.a1?.[0] as { state?: { status?: string } })?.state?.status).not.toBe("running")
})

// openchamber#438 review 3.
const activeInIndex = (id: string) => useGlobalSessionStatusStore.getState().activeSessionIds.has(id)
test("review 3 #1: same-directory absence of an ordinary busy session keeps its global entry and active membership", async () => {
  const store = new ChildStoreManager().ensureChild(NET, { bootstrap: false })
  const { messages, parts } = running()
  store.setState({ session_status: { [S]: busyOrdinary }, message: { [S]: messages }, part: parts })
  applyGlobalSessionStatusSnapshot(NET, { [S]: busyOrdinary }, [S]) // Indexed under the directory being resynced.
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => ({}) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
  await resyncDirectorySessionStatuses(NET, store, [S], "authoritative")
  expect(store.getState().session_status?.[S]?.type).toBe("busy")
  expect(useGlobalSessionStatusStore.getState().statusById.get(S)?.status.type).toBe("busy")
  expect(activeInIndex(S)).toBe(true)
  expect((store.getState().part.a1?.[0] as { state?: { status?: string } })?.state?.status).toBe("running")
})
test("review 3 #1: a busy child, an empty global index and a busy fleet answer: the global index takes busy too", async () => {
  const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
  const { messages, parts } = running()
  store.setState({ session_status: { [S]: { type: "busy" } }, message: { [S]: messages }, part: parts })
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => (d ? {} : { [S]: { type: "retry", attempt: 1, message: "x", next: 1 } }) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
  await resyncDirectorySessionStatuses(CODE, store, [S], "authoritative")
  expect(store.getState().session_status?.[S]?.type).toBe("busy")
  expect(useGlobalSessionStatusStore.getState().statusById.get(S)?.status.type).toBe("retry")
  expect(activeInIndex(S)).toBe(true)
  expect((store.getState().part.a1?.[0] as { state?: { status?: string } })?.state?.status).toBe("running")
})
for (const change of ["endpoint", "sign-in"] as const) {
  test(`review 3 #2: a ${change} change while the fleet read is pending publishes nothing of the stale read`, async () => {
    const { switchRuntimeEndpoint } = await import("@/lib/runtime-switch")
    const { resetRuntimeAuthGeneration } = await import("@/lib/runtime-auth")
    const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
    const { messages, parts } = running()
    store.setState({ session: [managed(CODE)], session_status: { [S]: { type: "busy" } }, message: { [S]: messages }, part: parts })
    applyGlobalSessionStatusSnapshot(NET, { [S]: { type: "busy" } }, [S])
    let release: (value: unknown) => void = () => {}
    spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => d ? ({}) as never
      : await new Promise<unknown>((resolve) => { release = resolve }) as never))
    useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
    // A managed session absent here with an index entry elsewhere is held without a fleet read; drop the index so the read runs.
    replaceGlobalSessionStatusById(new Map())
    const pending = resyncDirectorySessionStatuses(CODE, store, [S], "authoritative")
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (change === "endpoint") switchRuntimeEndpoint({ apiBaseUrl: "", runtimeKey: `other-${Date.now()}` }); else resetRuntimeAuthGeneration()
    const newIndex = new Map([["other-session", { status: { type: "busy" } as never, directory: "/p/new" }]])
    replaceGlobalSessionStatusById(newIndex)
    release(null)
    expect(await pending).toBeNull()
    expect([...useGlobalSessionStatusStore.getState().statusById.keys()]).toEqual(["other-session"]) // The new runtime's index.
    expect(store.getState().session_status?.[S]?.type).toBe("busy") // The old store untouched.
    expect((store.getState().part.a1?.[0] as { state?: { status?: string } })?.state?.status).toBe("running")
  })
}

// openchamber#438 review 4.
const idsWith = () => [...useGlobalSessionStatusStore.getState().statusById.entries()].map(([id, e]) => [id, e.status.type, activeInIndex(id)])
const A = "01a0-sess-a", B = "01a0-sess-b", C = "01a0-sess-c"
test("review 4 #1: repairing absent sessions from the fleet never clears a live sibling or another held session", async () => {
  const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
  store.setState({ session: [managed(CODE), { id: B, directory: CODE }, { id: C, directory: CODE }] as never,
    session_status: { [A]: { type: "busy" }, [B]: { type: "busy" }, [C]: busyOrdinary } as never })
  applyGlobalSessionStatusSnapshot(CODE, { [C]: busyOrdinary }, [C]) // C: an ordinary busy session, indexed here.
  // This directory lists B busy; omits A (managed, no global entry) and C (ordinary). The fleet has A retry and S busy.
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => (d ? { [B]: { type: "busy" } }
    : { [A]: { type: "retry", attempt: 1, message: "x", next: 1 }, [S]: { type: "busy" } }) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
  store.setState((s) => ({ session: [...s.session, managed(CODE)].map((x, i) => i === 0 ? { ...x, id: A } : x) as never,
    session_status: { ...(s.session_status ?? {}), [S]: { type: "busy" } } }))
  await resyncDirectorySessionStatuses(CODE, store, [A, B, C, S], "authoritative")
  const got = Object.fromEntries(idsWith().map(([id, type, act]) => [id as string, `${type}/${act}`]))
  expect(got[A]).toBe("retry/true") // Repaired.
  expect(got[S]).toBe("busy/true") // Repaired too; the first repair did not clear it.
  expect(got[B]).toBe("busy/true") // The live sibling stays.
  expect(got[C]).toBe("busy/true") // The held ordinary session stays.
})
test("review 4 #2: a newer busy event and running tool that arrive while the fleet read is out are never settled", async () => {
  const { applyGlobalSessionStatusEvent } = await import("./global-session-status")
  const store = new ChildStoreManager().ensureChild(CODE, { bootstrap: false })
  store.setState({ session: [managed(CODE)], session_status: {} })
  let release: (value: unknown) => void = () => {}
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => d ? ({}) as never
    : await new Promise<unknown>((resolve) => { release = resolve }) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
  const pending = resyncDirectorySessionStatuses(CODE, store, [S], "authoritative")
  await new Promise((resolve) => setTimeout(resolve, 0))
  // A new turn starts meanwhile: its busy event and running tool reach both stores.
  const { messages, parts } = running()
  applyGlobalSessionStatusEvent(CODE, { type: "session.status", properties: { sessionID: S, status: { type: "busy" } } } as never)
  store.setState({ session_status: { [S]: { type: "busy" } }, message: { [S]: messages }, part: parts })
  release({}) // The old fleet read: S absent there too.
  await pending
  expect(store.getState().session_status?.[S]?.type).toBe("busy")
  expect(useGlobalSessionStatusStore.getState().statusById.get(S)?.status.type).toBe("busy")
  expect((store.getState().part.a1?.[0] as { state?: { status?: string } })?.state?.status).toBe("running")
})
test("review 4 #3: the send preflight decides from the reconciled status: a held busy session is not idle", async () => {
  const { reconcileSessionIdleBeforeSend } = await import("./sync-context")
  const { setSyncRefs } = await import("./sync-refs")
  const manager = new ChildStoreManager()
  const store = manager.ensureChild(CODE, { bootstrap: false })
  store.setState({ session: [managed(CODE)], session_status: { [S]: { type: "busy" } } })
  setSyncRefs(Object.create(null), manager, CODE)
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async (d) => (d ? {} : { [S]: { type: "busy" } }) as never))
  useProjectsStore.setState({ managedCatalogAdmitted: true } as never)
  expect(await reconcileSessionIdleBeforeSend(CODE, S)).toBe(false) // The fleet says busy: queue/steer, not a plain submit.
  spies.splice(0).forEach((x) => x.mockRestore())
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => ({}) as never))
  store.setState({ session_status: { [S]: { type: "busy" } } })
  expect(await reconcileSessionIdleBeforeSend(CODE, S)).toBe(true) // Counterexample: no one says busy: idle (#2577).
})
