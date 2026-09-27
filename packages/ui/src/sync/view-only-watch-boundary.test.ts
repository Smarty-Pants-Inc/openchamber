import { expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline, eventStreamBoundaryWaiters } from "./event-pipeline"
import { applyDirectoryEvent } from "./event-reducer"
import { setImperativeSessionMessageLoader } from "./session-message-loader"
import { record, setup, sleep, target } from "./session-message-loader-replace.fixture"
import { readLatest } from "./view-only-watch"

// #278 review 10: a watch that did not resume opens an ordering boundary on the page's event stream before its read.
const updated = (id: string) => ({ type: "message.updated", properties: { sessionID: target.sessionID, info: record(id).info } }) as unknown as Event
const connected = { type: "server.connected", properties: {} } as unknown as Event
/** An SSE gateway whose connections are scripted: each yields `connected`, then what the test pushes to it. */
function gateway() {
  const connections: { push: (event: Event) => void; hold: (event: Event) => void; release: () => void; aborted: () => boolean }[] = []
  const sdk = { global: { event: async ({ signal }: { signal: AbortSignal }) => {
    const pending: Event[] = [connected], held: Event[] = []; let wake = () => {}
    signal.addEventListener("abort", () => wake(), { once: true })
    connections.push({ push: (event) => { pending.push(event); wake() }, hold: (event) => { held.push(event) },
      release: () => { pending.push(...held.splice(0)); wake() }, aborted: () => signal.aborted })
    return { stream: (async function* () {
      for (;;) {
        while (pending.length) yield { directory: target.directory, payload: pending.shift()! }
        if (signal.aborted) { // Closed: a frame already in the socket's buffer is still read once (the worst case).
          pending.push(...held.splice(0))
          while (pending.length) yield { directory: target.directory, payload: pending.shift()! }
          return
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    })() }
  } } } as unknown as OpencodeClient
  return { sdk, connections }
}
function run() {
  const s = setup(), gw = gateway()
  setImperativeSessionMessageLoader(s.loader)
  const pipeline = createEventPipeline({ sdk: gw.sdk, transport: "sse", heartbeatTimeoutMs: 60_000,
    onEvents: (_d, events) => { // Applied synchronously, as sync-context does.
      const draft = { ...s.store().getState() }
      for (const event of events) applyDirectoryEvent(draft as never, event as never)
      s.store().setState(draft)
    } })
  const done = () => { pipeline.cleanup(); setImperativeSessionMessageLoader(null); s.done() }
  return { s, gw, done }
}

test("not resumed: a frame of the old branch still on the old stream, released after the replacement, is dropped", async () => {
  const { s, gw, done } = run()
  try {
    s.g.branch = ["m0001"]; await s.loader.ensure(target, { reason: "navigation" }); await sleep(20)
    s.g.branch = ["m0001", "m0003"] // The persisted branch is now [a,c]; b (m0002) was published on the old tail
    gw.connections[0]!.hold(updated("m0002")) // and is buffered on the page's current connection.
    await readLatest(target.sessionID, target.directory, new AbortController().signal, false)
    expect(gw.connections.length).toBe(2) // The page reopened its stream before the read,
    expect(gw.connections[0]!.aborted()).toBe(true)
    expect(s.shown()).toEqual(["m0001", "m0003"])
    gw.connections[0]!.release(); await sleep(100) // b, had it been on the old connection still, arrives now.
    expect(s.shown()).toEqual(["m0001", "m0003"]) // Never applied.
    gw.connections[1]!.push(updated("m0004")) // Counterexample: an entry committed after the boundary is shown.
    await sleep(100)
    expect(s.shown()).toEqual(["m0001", "m0003", "m0004"])
  } finally { done() }
})

test("not resumed: frames received before the boundary are delivered before the read, which supersedes them", async () => {
  const { s, gw, done } = run()
  try {
    s.g.branch = ["m0001"]; await s.loader.ensure(target, { reason: "navigation" }); await sleep(20)
    s.g.branch = ["m0001", "m0003"]; s.g.holdNext = true
    gw.connections[0]!.push(updated("m0001")); await sleep(5) // A flush, so the next frame waits for the next frame tick,
    gw.connections[0]!.push(updated("m0002")); await sleep(1) // and b is received but still queued (33 ms)
    const reads = s.g.reads
    const reading = readLatest(target.sessionID, target.directory, new AbortController().signal, false) // when the boundary opens.
    for (let i = 0; i < 100 && s.g.gates.length === 0; i++) await sleep(2)
    expect(s.shown()).toEqual(["m0001", "m0002"]) // b was applied before the history read started,
    s.g.holdNext = false; s.g.gates.shift()?.(); await reading
    await sleep(100)
    expect(s.shown()).toEqual(["m0001", "m0003"]) // which supersedes it,
    expect(s.g.reads).toBe(reads + 1) // with exactly one read.
  } finally { done() }
})

test("resumed: no boundary; the stream stays and its events still apply", async () => {
  const { s, gw, done } = run()
  try {
    s.g.branch = ["m0001"]; await s.loader.ensure(target, { reason: "navigation" }); await sleep(20)
    s.g.branch = ["m0001", "m0002"]
    await readLatest(target.sessionID, target.directory, new AbortController().signal, true)
    expect(gw.connections.length).toBe(1)
    gw.connections[0]!.push(updated("m0003")); await sleep(100)
    expect(s.shown()).toEqual(["m0001", "m0002", "m0003"])
  } finally { done() }
})

test("a pipeline replaced before its fresh connection's first frame hands the boundary to its successor", async () => {
  const s = setup(), gw = gateway()
  setImperativeSessionMessageLoader(s.loader)
  const first = createEventPipeline({ sdk: gw.sdk, transport: "sse", heartbeatTimeoutMs: 60_000, onEvents: () => {} })
  try {
    await s.loader.ensure(target, { reason: "navigation" }); await sleep(20)
    let fresh = false
    const waiting = readLatest(target.sessionID, target.directory, new AbortController().signal, false).then(() => { fresh = true })
    first.cleanup() // A new SDK or transport: the page's pipeline is recreated,
    await sleep(50)
    expect(fresh).toBe(false) // and the cleanup does not count as a fresh connection.
    const reads = s.g.reads
    const second = createEventPipeline({ sdk: gw.sdk, transport: "sse", heartbeatTimeoutMs: 60_000, onEvents: () => {} })
    await waiting
    expect(fresh).toBe(true) // The successor's first connection releases it,
    expect(s.g.reads).toBe(reads + 1) // and only then is the history read.
    second.cleanup()
  } finally { first.cleanup(); setImperativeSessionMessageLoader(null); s.done() }
})

test("a session other than the watched one keeps an update received before the boundary", async () => {
  const s = setup(), gw = gateway(), other: string[] = []
  setImperativeSessionMessageLoader(s.loader)
  const pipeline = createEventPipeline({ sdk: gw.sdk, transport: "sse", heartbeatTimeoutMs: 60_000,
    onEvents: (_d, events) => { for (const event of events) other.push((event.properties as { sessionID?: string }).sessionID ?? "") } })
  try {
    await sleep(20)
    gw.connections[0]!.push({ type: "session.idle", properties: { sessionID: "b" } } as unknown as Event); await sleep(5)
    gw.connections[0]!.push({ type: "session.idle", properties: { sessionID: "b2" } } as unknown as Event); await sleep(1) // Queued,
    await readLatest(target.sessionID, target.directory, new AbortController().signal, false) // then a boundary.
    await sleep(60)
    expect(other).toContain("b2")
  } finally { pipeline.cleanup(); setImperativeSessionMessageLoader(null); s.done() }
})

test("a watch that ends while its boundary waits leaves no waiter behind", async () => {
  const s = setup()
  setImperativeSessionMessageLoader(s.loader)
  try {
    const stop = new AbortController()
    const waiting = readLatest(target.sessionID, target.directory, stop.signal, false) // No pipeline: it waits,
    await sleep(5)
    expect(eventStreamBoundaryWaiters()).toBe(1)
    stop.abort(); await waiting // until the watch ends,
    expect(eventStreamBoundaryWaiters()).toBe(0) // and then nothing is kept.
    await readLatest(target.sessionID, target.directory, stop.signal, false) // Already ended: never registered.
    expect(eventStreamBoundaryWaiters()).toBe(0)
  } finally { setImperativeSessionMessageLoader(null); s.done() }
})
