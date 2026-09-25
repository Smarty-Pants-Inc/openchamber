import { beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { clearLastActiveSession, isLastActiveSession, persistLastActiveSession, readLastActiveSession } from "./last-session-cache"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

let storage: TestStorage

beforeEach(() => {
  storage = new TestStorage()
})

describe("last active session persistence", () => {
  test("keeps independent entries per runtime", () => {
    persistLastActiveSession("runtime-a", { sessionId: "ses-a", directory: "/repo/a" }, storage)
    persistLastActiveSession("runtime-b", { sessionId: "ses-b", directory: null }, storage)

    expect(readLastActiveSession("runtime-a", storage)).toEqual({ sessionId: "ses-a", directory: "/repo/a" })
    expect(readLastActiveSession("runtime-b", storage)).toEqual({ sessionId: "ses-b", directory: null })
  })

  test("overwrites the entry for the same runtime", () => {
    persistLastActiveSession("runtime-a", { sessionId: "ses-1", directory: "/repo" }, storage)
    persistLastActiveSession("runtime-a", { sessionId: "ses-2", directory: null }, storage)

    expect(readLastActiveSession("runtime-a", storage)).toEqual({ sessionId: "ses-2", directory: null })
  })

  test("clear removes only the targeted runtime", () => {
    persistLastActiveSession("runtime-a", { sessionId: "ses-a", directory: null }, storage)
    persistLastActiveSession("runtime-b", { sessionId: "ses-b", directory: null }, storage)

    clearLastActiveSession("runtime-a", storage)

    expect(readLastActiveSession("runtime-a", storage)).toBeNull()
    expect(readLastActiveSession("runtime-b", storage)).toEqual({ sessionId: "ses-b", directory: null })
  })

  test("malformed persisted payload reads as empty, not a crash", () => {
    storage.setItem("oc.lastSession.v1", "{not json")
    expect(readLastActiveSession("runtime-a", storage)).toBeNull()

    storage.setItem("oc.lastSession.v1", JSON.stringify({ version: 99, runtimes: { "runtime-a": { sessionId: "x" } } }))
    expect(readLastActiveSession("runtime-a", storage)).toBeNull()
  })

  test("bounds retained runtime namespaces", () => {
    for (let index = 0; index < 10; index += 1) {
      persistLastActiveSession(`runtime-${index}`, { sessionId: `ses-${index}`, directory: null }, storage)
    }
    const retained = Array.from({ length: 10 }, (_, index) => readLastActiveSession(`runtime-${index}`, storage))
      .filter(Boolean)
    expect(retained.length).toBe(8)
    // Newest entries survive.
    expect(readLastActiveSession("runtime-9", storage)).not.toBeNull()
    expect(readLastActiveSession("runtime-0", storage)).toBeNull()
  })
})

// smarty-code#113: a draft action clears the pointer; the address bar must not keep that session for a reload to restore.
describe("clearing the pointer and the address bar", () => {
  const withWindow = (href: string, run: (win: Window) => void) => {
    const win = new Window({ url: href })
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: win })
    try { run(win) } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window")
      void win.happyDOM.close()
    }
  }
  test("drops exactly the cleared session from ?session=, and keeps every other parameter", () => {
    withWindow("https://code.example/?session=ses-a&tab=git", win => {
      persistLastActiveSession("runtime-a", { sessionId: "ses-a", directory: null }, storage)
      clearLastActiveSession("runtime-a", storage)
      expect(win.location.search).toBe("?tab=git")
    })
  })
  test("keeps a different session in the address, and an embedded session chat's identity", () => {
    for (const href of ["https://code.example/?session=ses-other", "https://code.example/?ocPanel=1&session=ses-a"]) {
      withWindow(href, win => {
        persistLastActiveSession("runtime-a", { sessionId: "ses-a", directory: null }, storage)
        clearLastActiveSession("runtime-a", storage)
        expect(win.location.href).toBe(href)
      })
    }
  })
  test("a restore is still intended only while the pointer names the same session", () => {
    persistLastActiveSession("runtime-a", { sessionId: "ses-a", directory: null }, storage)
    expect(isLastActiveSession("runtime-a", "ses-a", storage)).toBe(true)
    clearLastActiveSession("runtime-a", storage) // A draft action while the snapshot loaded.
    expect(isLastActiveSession("runtime-a", "ses-a", storage)).toBe(false)
  })
})
