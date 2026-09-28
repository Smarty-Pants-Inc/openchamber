import { expect, test } from "bun:test"
import { draftAtRisk, entryScript, holdReload, reloadHeld, reloadIfNewBuild } from "./newBuildReload"

// smarty-code (Release 3.41, 01:44Z): after the install restarted the service, Kate's open page reconnected but kept
// 3.40's JavaScript and marked a finished tool "Interrupted". A reconnect now reloads a page running an older build.
const index = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`
const run = async (options: { running?: string; served?: string; busy?: boolean; fails?: boolean }) => {
  let reloaded = 0
  const result = await reloadIfNewBuild({
    running: () => options.running,
    fetchIndex: async () => { if (options.fails) throw new Error("offline"); return options.served ?? "" },
    busy: () => options.busy ?? false,
    reload: () => { reloaded += 1 },
  })
  return { result, reloaded }
}

test("a page running an older build reloads into the served one", async () => {
  expect(await run({ running: "/assets/main-OLD111.js", served: index("/assets/main-NEW222.js") }))
    .toEqual({ result: true, reloaded: 1 })
})

test("counterexamples: the same build, attached files, a failed fetch or no entry never reload", async () => {
  const same = { running: "/assets/main-AAA.js", served: index("/assets/main-AAA.js") }
  expect(await run(same)).toEqual({ result: false, reloaded: 0 })
  expect(await run({ running: "/assets/main-OLD.js", served: index("/assets/main-NEW.js"), busy: true }))
    .toEqual({ result: false, reloaded: 0 }) // Files attached: waits for the next reconnect.
  expect(await run({ running: "/assets/main-OLD.js", fails: true })).toEqual({ result: false, reloaded: 0 })
  expect(await run({ running: "/assets/main-OLD.js", served: "<html>maintenance</html>" })).toEqual({ result: false, reloaded: 0 })
  expect(await run({ running: undefined, served: index("/assets/main-NEW.js") })).toEqual({ result: false, reloaded: 0 })
})

test("the entry is read from a built index.html", () => {
  const built = `<script type="module" crossorigin src="/assets/main-9Fh6rprq.js"></script><link rel="modulepreload" href="/assets/vendor-x.js">`
  expect(entryScript(built)).toBe("/assets/main-9Fh6rprq.js")
})

// openchamber#333 review: a reload must not lose a draft that is not safely saved, nor a send still in preparation.
const reconnect = async () => {
  let reloaded = 0
  await reloadIfNewBuild({ running: () => "/assets/main-OLD.js", fetchIndex: async () => index("/assets/main-NEW.js"),
    busy: () => reloadHeld(), reload: () => { reloaded += 1 } })
  return reloaded
}

test("a draft with persistence off or failing storage holds the reload; a safely saved or empty one does not", async () => {
  expect(draftAtRisk("unsent words", false, false)).toBe(true) // Persist Draft Messages off.
  expect(draftAtRisk("unsent words", true, true)).toBe(true) // Storage write failed: ephemeral only.
  expect(draftAtRisk("  ", false, false)).toBe(true) // Whitespace is a person's draft too.
  expect(draftAtRisk("unsent words", true, false)).toBe(false) // Saved: it survives the reload.
  expect(draftAtRisk("", false, true)).toBe(false) // Nothing to lose.
  let text = "unsent words", persist = false
  const release = holdReload(() => draftAtRisk(text, persist, false)) // As ChatInput registers it: read live.
  expect(await reconnect()).toBe(0)
  persist = true // The person turns persistence on: the draft is saved now.
  expect(await reconnect()).toBe(1)
  persist = false; text = ""
  expect(await reconnect()).toBe(1) // Sent or cleared: a later reconnect reloads.
  release()
})

test("a send holds the reload from its preparation until its request settles; then a later reconnect reloads", async () => {
  let settle!: () => void
  const sent = new Promise<void>((resolve) => { settle = resolve })
  const release = holdReload() // submitComposer: before the composer is cleared.
  expect(await reconnect()).toBe(0) // Held while the prompt is prepared (the composer is already empty).
  void sent.then(release, release) // submitComposer's finally: released when the send settles.
  expect(await reconnect()).toBe(0) // The request is outstanding.
  settle(); await sent
  expect(await reconnect()).toBe(1)
})
