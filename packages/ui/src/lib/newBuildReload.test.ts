import { expect, test } from "bun:test"
import { entryScript, holdReload, reloadHeld, reloadIfNewBuild } from "./newBuildReload"

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

test("any text in the composer holds the reload; an empty composer lets it go", async () => {
  let text = "unsent words"
  const release = holdReload(() => text !== "") // As ChatInput registers it: the editor's text, read live.
  expect(await reconnect()).toBe(0)
  text = "  " // Whitespace is a person's draft too.
  expect(await reconnect()).toBe(0)
  text = "" // Sent or cleared: the next reconnect reloads.
  expect(await reconnect()).toBe(1)
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

// 3.54 gate audit (smarty-code, 22:48Z): every open 3.53 tab reloaded at the same instant after the install, and the
// burst gave 227 slow reads in 5 min. Each tab now waits its own random delay (0-60 s) before it reloads, and reloads
// then only if nothing holds it.
test("a new build reloads after the tab's own random delay, not at once", async () => {
  const order: string[] = []
  const result = await reloadIfNewBuild({
    running: () => "/assets/main-OLD.js",
    fetchIndex: async () => index("/assets/main-NEW.js"),
    busy: () => false,
    reload: () => { order.push("reload") },
    jitterMs: () => 42_000,
    sleep: async (ms) => { order.push(`wait ${ms}`) },
  })
  expect(result).toBe(true)
  expect(order).toEqual(["wait 42000", "reload"])
})

test("counterexample: text typed during the delay holds the reload (the next reconnect tries again)", async () => {
  let held = false, reloaded = 0
  const result = await reloadIfNewBuild({
    running: () => "/assets/main-OLD.js",
    fetchIndex: async () => index("/assets/main-NEW.js"),
    busy: () => held,
    reload: () => { reloaded += 1 },
    jitterMs: () => 30_000,
    sleep: async () => { held = true },
  })
  expect({ result, reloaded }).toEqual({ result: false, reloaded: 0 })
})

test("the default delay is spread over 0-60 s", async () => {
  const { defaultReloadJitterMs } = await import("./newBuildReload")
  const samples = Array.from({ length: 200 }, () => defaultReloadJitterMs())
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
  expect(Math.max(...samples)).toBeLessThanOrEqual(60_000)
  expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(30_000)
})
