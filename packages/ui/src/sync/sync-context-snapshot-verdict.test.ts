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
