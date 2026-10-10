import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { create } from "zustand"
import type { Session } from "@opencode-ai/sdk/v2"
import { opencodeClient } from "@/lib/opencode/client"
import { toast } from "@/components/ui/toast"
import { isHerdrEnded } from "@/lib/herdrSession"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { createEventRoutingIndex, refreshSessionRecord, resyncDirectoryAfterReconnect, setActiveSession } from "./sync-context"
import { resetGoneSessionNotices } from "./gone-session-notice"
import { useSessionUIStore } from "./session-ui-store"
import { setSyncRefs } from "./sync-refs"
import { clearSessionReadFailures, isSessionGone, TERMINAL_SESSION_READ_BACKOFF_MS } from "./terminal-session-reads"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"

// smarty-code#1575 round 2 (openchamber#604 review): the watchdog's own 404 on the open session, the expiry of the 60 s
// back-off, and a listing that names the session while its read is in flight.
const GATEWAY = "Unknown Pi session in requested project"
const dir = "/gone-a"
const row = (id: string): Session => ({ id, directory: dir, title: id, slug: id, projectID: dir, version: "1", time: { created: 1, updated: 1 } })
const open = row("open-a"), other = row("other-b")
const DEFAULT = "This session is no longer available: its Pi ended or its worktree was removed."

let now = 1_000_000
const reads: string[] = []
const shown: string[] = []
let answer: (sessionID: string) => Promise<number> = async () => 404
const spies: { mockRestore(): void }[] = []
const child = create<DirectoryStore>((set) => ({ ...INITIAL_STATE, patch: (partial) => set(partial), replace: (next) => set(next) }))
const initialGlobals = useGlobalSessionsStore.getState(), initialUi = useSessionUIStore.getState()

const respond = async (sessionID: string) => {
  reads.push(sessionID)
  const status = await answer(sessionID)
  const request = new Request("http://x"), response = new Response(null, { status })
  return status === 200 ? { data: sessionID === open.id ? open : other, error: undefined, request, response }
    : { data: undefined, error: { name: "NotFoundError" as const, data: { message: GATEWAY } }, request, response }
}

beforeEach(() => {
  now = 1_000_000; reads.length = 0; shown.length = 0; answer = async () => 404
  clearSessionReadFailures(); resetGoneSessionNotices()
  spies.push(spyOn(Date, "now").mockImplementation(() => now))
  spies.push(spyOn(toast, "warning").mockImplementation(message => { shown.push(String(message)); return "toast" }))
  spies.push(spyOn(opencodeClient, "getSessionStatusForDirectory").mockImplementation(async () => ({})))
  spies.push(spyOn(opencodeClient, "listPendingQuestions").mockImplementation(async () => []))
  spies.push(spyOn(opencodeClient, "listPendingPermissions").mockImplementation(async () => []))
  spies.push(spyOn(opencodeClient.getScopedSdkClient(dir).session, "get").mockImplementation(({ sessionID }) => respond(sessionID)))
  const manager: Parameters<typeof setSyncRefs>[1] = Object.assign(Object.create(null), {
    children: new Map([[dir, child]]), getChild: () => child, ensureChild: () => child, getState: () => child.getState() })
  setSyncRefs(Object.create(null), manager, dir)
  setActiveSession(dir, open.id)
  useSessionUIStore.setState({ currentSessionId: open.id, currentSessionDirectory: dir })
  useGlobalSessionsStore.getState().applyManagedSessions([open, other], useGlobalSessionsStore.getState().mutationRevision, new Set([dir]))
})
afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore())
  useGlobalSessionsStore.setState(initialGlobals, true); useSessionUIStore.setState(initialUi, true)
})

// The watchdog's stale-status resync: the open session is always a candidate; `other` is one while it looks busy.
const watchdogPass = async () => {
  child.setState({ ...INITIAL_STATE, session: [open, other], session_status: { [other.id]: { type: "busy" } } })
  await resyncDirectoryAfterReconnect(dir, child, createEventRoutingIndex(), "stale-status-resync")
}
const ended = () => isHerdrEnded(useGlobalSessionsStore.getState().entityById.get(open.id))

test("the watchdog's 404 on the open session ends it at once: the ended row and the notice once (P1-2)", async () => {
  await watchdogPass()
  expect(reads.filter(id => id === open.id)).toEqual([open.id])
  expect(isSessionGone(dir, open.id)).toBe(true)
  expect(ended()).toBe(true)
  expect(shown).toEqual([DEFAULT])
})

test("a gone open session stays unread by the watchdog after the 60 s back-off; other sessions keep the back-off (P1-1)", async () => {
  await watchdogPass()
  for (let pass = 0; pass < 20; pass++) { now += 30_000; await watchdogPass() }
  expect(reads.filter(id => id === open.id)).toEqual([open.id])
  // The other session's 404 is not "gone": it is read again each time its 60 s back-off ends (10 min: 11 reads).
  expect(TERMINAL_SESSION_READ_BACKOFF_MS).toBe(60_000)
  expect(reads.filter(id => id === other.id).length).toBe(11)
  expect(isSessionGone(dir, other.id)).toBe(false)
  expect(shown).toEqual([DEFAULT])
})

test("a listing that names the session while its read is in flight makes the late 404 stale (P1-3)", async () => {
  for (const reader of ["refresh", "watchdog"] as const) {
    clearSessionReadFailures(); resetGoneSessionNotices(); shown.length = 0
    let release: (status: number) => void = () => undefined
    answer = (sessionID) => sessionID === open.id ? new Promise(resolve => { release = resolve }) : Promise.resolve(404)
    const read = reader === "refresh" ? refreshSessionRecord(open.id, dir) : watchdogPass()
    await new Promise(resolve => setTimeout(resolve, 0))
    useGlobalSessionsStore.getState().applyManagedSessions([open, other], useGlobalSessionsStore.getState().mutationRevision, new Set([dir]))
    release(404)
    await read
    expect({ reader, gone: isSessionGone(dir, open.id), ended: ended(), shown: [...shown] })
      .toEqual({ reader, gone: false, ended: false, shown: [] })
  }
  // Counterexample: a 404 whose read started after that listing still ends it.
  answer = async () => 404
  await refreshSessionRecord(open.id, dir)
  expect(isSessionGone(dir, open.id)).toBe(true)
  expect(ended()).toBe(true)
  expect(shown).toEqual([DEFAULT])
})
