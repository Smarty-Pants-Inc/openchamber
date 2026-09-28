import { expect, test } from "bun:test"
import { entryScript, reloadIfNewBuild } from "./newBuildReload"

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
