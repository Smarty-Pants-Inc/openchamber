import { beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { getSafeSessionStorage } from "@/stores/utils/safeStorage"
import { clearLastActiveSession, isLastActiveSession, persistLastActiveSession, readLastActiveSession, setShownSessionProbe } from "./last-session-cache"

// Each tab's own choice (sessionStorage) wins over the shared pointer that any tab moves.
class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

class FailingStorage extends TestStorage {
  override getItem(): string | null { throw new Error("blocked") }
  override setItem(): void { throw new Error("blocked") }
}

const tabKey = (runtimeKey: string) => `oc.lastSession.tab.v1:${runtimeKey}`
const x = { sessionId: "ses-x", directory: "/repo" }
let shared: TestStorage, tabA: TestStorage, tabB: TestStorage

beforeEach(() => {
  shared = new TestStorage()
  tabA = new TestStorage()
  tabB = new TestStorage()
})

test("a draft in tab B survives tab A choosing a session, across B's reload", () => {
  clearLastActiveSession("rt", shared, tabB) // B: New session.
  persistLastActiveSession("rt", x, shared, tabA) // A: Send moves the shared pointer.
  expect(readLastActiveSession("rt", shared)).toEqual(x)
  // B reloads: sessionStorage and localStorage survive.
  const reloadedB = new TestStorage()
  for (const [key, value] of tabB.values) reloadedB.setItem(key, value)
  expect(readLastActiveSession("rt", shared, reloadedB)).toBeNull()
  expect(readLastActiveSession("rt", shared, tabA)).toEqual(x)
  expect(isLastActiveSession("rt", "ses-x", shared, reloadedB)).toBe(false)
})

test("controls: a tab reloads its own session; a fresh tab falls back to the shared pointer", () => {
  persistLastActiveSession("rt", { sessionId: "ses-b", directory: null }, shared, tabB)
  persistLastActiveSession("rt", x, shared, tabA)
  expect(readLastActiveSession("rt", shared, tabB)).toEqual({ sessionId: "ses-b", directory: null })
  expect(readLastActiveSession("rt", shared, new TestStorage())).toEqual(x)
  expect(readLastActiveSession("rt", new TestStorage(), new TestStorage())).toBeNull()
})

test("tab choices are per runtime", () => {
  persistLastActiveSession("rt-2", x, shared, tabA)
  clearLastActiveSession("rt-1", shared, tabB)
  expect(readLastActiveSession("rt-1", shared, tabB)).toBeNull()
  expect(readLastActiveSession("rt-2", shared, tabB)).toEqual(x)
})

test("a malformed tab record falls back to the shared pointer", () => {
  persistLastActiveSession("rt", x, shared, tabA)
  for (const raw of ["{bad", "\"ses-x\"", JSON.stringify({ sessionId: 3 }), JSON.stringify({ sessionId: "", directory: null }),
    JSON.stringify({ sessionId: "ses-y", directory: "" })]) {
    tabB.setItem(tabKey("rt"), raw)
    expect(readLastActiveSession("rt", shared, tabB)).toEqual(x)
  }
})

test("clearing records the tab's draft even without a shared pointer, and drops that session's route", () => {
  const win = new Window({ url: "https://code.example/?session=ses-x&tab=git" })
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  setShownSessionProbe(() => ({ applying: false, shown: null }))
  try {
    persistLastActiveSession("rt", x, new TestStorage(), tabB) // Shared pointer lives elsewhere (absent here).
    clearLastActiveSession("rt", shared, tabB)
    expect(tabB.getItem(tabKey("rt"))).toBe("null")
    expect(win.location.search).toBe("?tab=git")
  } finally {
    setShownSessionProbe(undefined)
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window")
    void win.happyDOM.close()
  }
})

test("a blocked tab storage is best effort: the shared pointer still works", () => {
  const blocked = new FailingStorage()
  persistLastActiveSession("rt", x, shared, blocked) // A throw here fails the test.
  expect(readLastActiveSession("rt", shared, blocked)).toEqual(x)
  clearLastActiveSession("rt", shared, blocked)
  expect(readLastActiveSession("rt", shared, blocked)).toBeNull()
})

test("omitted storage uses the shared and this tab's default stores", () => {
  persistLastActiveSession("rt-default", x)
  expect(getSafeSessionStorage().getItem(tabKey("rt-default"))).toBe(JSON.stringify(x))
  clearLastActiveSession("rt-default")
  expect(getSafeSessionStorage().getItem(tabKey("rt-default"))).toBe("null")
  expect(readLastActiveSession("rt-default")).toBeNull()
})
