import { afterEach, beforeEach, expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { fakeMessagesClient, record } from "./session-message-loader-replace.fixture"

// smarty-code#1501 review P3: with session-load diagnostics on, one newest-page read is one `session-messages.page`
// completion, whether the gateway answered journal-only or normally.
const target = { directory: "/repo", sessionID: "session-a" }
type DiagnosticEvent = { operation: string; outcome: string; recordCount?: number; retryCount?: number }
type DiagnosticWindow = {
  location: { search: string }
  localStorage: { getItem: (key: string) => string | null }
  __openchamberSessionLoadPerformance?: { events: DiagnosticEvent[] }
}

let originalWindow: PropertyDescriptor | undefined
let diagnosticWindow: DiagnosticWindow
let cleanup: (() => void) | undefined

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = new Map([["openchamber_session_load_perf", "1"]])
  diagnosticWindow = { location: { search: "" }, localStorage: { getItem: (key) => storage.get(key) ?? null } }
  Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

/** A gateway whose first read fails transiently (one retry), then answers `ids`, journal-only when `journalOnly`. */
function loaderFor(ids: string[], journalOnly: boolean) {
  let reads = 0
  const sdk = fakeMessagesClient(async () => {
    reads++
    if (reads === 1) throw new Error("opencode api unavailable (503)")
    const headers = new Headers()
    if (journalOnly) headers.set("x-smarty-journal-only", "1")
    return { data: ids.map(record), headers }
  })
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
  cleanup = () => { loader.dispose(); childStores.disposeAll() }
  return { loader, reads: () => reads }
}

const pageEvents = () => (diagnosticWindow.__openchamberSessionLoadPerformance?.events ?? [])
  .filter((event) => event.operation === "session-messages.page")

test("a journal-only page emits exactly one page completion with its record and retry counts", async () => {
  const s = loaderFor(["j0001", "j0003"], true)
  await s.loader.ensure(target, { reason: "navigation" })
  expect(s.loader.getSnapshot(target).provisional).toBe(true)
  expect(s.reads()).toBe(2)
  const events = pageEvents()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ outcome: "complete", recordCount: 2, retryCount: 1 })
})

test("a normal header-free page also emits exactly one page completion", async () => {
  const s = loaderFor(["m0001", "m0002", "m0003"], false)
  await s.loader.ensure(target, { reason: "navigation" })
  expect("provisional" in s.loader.getSnapshot(target)).toBe(false)
  expect(s.reads()).toBe(2)
  const events = pageEvents()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ outcome: "complete", recordCount: 3, retryCount: 1 })
})
