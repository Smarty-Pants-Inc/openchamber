import { expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { applyDirectoryEvent } from "./event-reducer"
import { setImperativeSessionMessageLoader } from "./session-message-loader"
import { record, setup, sleep, target } from "./session-message-loader-replace.fixture"
import type { State } from "./types"
import { readLatest } from "./view-only-watch"

// #278 review 11: the gateway stamps each View only event with the journal state it comes from (`smartyAt`) and each
// newest-page read with the state it reflects; after a read that replaced the history, an event from an older state
// is dropped, whatever socket, hub or buffer delayed it. No stream reset. The web server's shared hub and WebSocket bridge
// forward the stamp unchanged (packages/web/server/lib/event-stream/global-ws-bridge.stamp.test.js).
const updated = (id: string, at?: string): Event => {
  const info = record(id).info
  // The gateway's stamp rides as an extra property the SDK's Event type does not declare.
  const properties = at ? { sessionID: target.sessionID, info, smartyAt: at } : { sessionID: target.sessionID, info }
  return { id: `evt_updated_${id}`, type: "message.updated", properties }
}
/** The fixture's store, updated synchronously as sync-context does. */
const reducer = (s: ReturnType<typeof setup>) => (events: readonly Event[]) => {
  if (!s.store()) return // No history loaded yet.
  const draft = { ...s.store().getState() }
  for (const event of events) applyDirectoryEvent(draft, event)
  s.store().setState(draft)
}
/** The reviewer's sequence up to the replacement: [a,b] was shown with b's frame still in flight; the persisted branch is now
 * [a,c] (a native branch change: Pi appended c after moving its leaf back to a). */
async function recovered(s: ReturnType<typeof setup>) {
  s.g.branch = ["m0001"]; s.g.at = "7:0:100"; await s.loader.ensure(target, { reason: "navigation" })
  s.g.branch = ["m0001", "m0003"]; s.g.at = "7:0:300" // b was committed at offset 200, then the branch changed.
  await readLatest(target.sessionID, target.directory, new AbortController().signal, false) // The watch did not resume.
  expect({ shown: s.shown(), reads: s.g.reads }).toEqual({ shown: ["m0001", "m0003"], reads: 2 })
}

test("SSE: the old branch's frame, delivered after the replacement, is dropped; a newer one applies", async () => {
  const s = setup(); setImperativeSessionMessageLoader(s.loader)
  const pending: Event[] = [{ id: "evt_connected", type: "server.connected", properties: {} }]; let wake = () => {}
  // SAFETY: a partial fake client; the SSE pipeline only calls `sdk.global.event({ signal, ... })` and iterates its
  // `stream` of `{ directory, payload }` frames.
  const sdk = { global: { event: async ({ signal }: { signal: AbortSignal }) => { signal.addEventListener("abort", () => wake(), { once: true })
    return { stream: (async function* () {
      while (!signal.aborted) { while (pending.length) yield { directory: target.directory, payload: pending.shift()! }; await new Promise<void>(r => { wake = r }) }
    })() } } } } as OpencodeClient
  const delivered = new Map<string, () => void>()
  const pipeline = createEventPipeline({ sdk, transport: "sse", heartbeatTimeoutMs: 60_000, onEvents: (_d, events) => {
    reducer(s)(events)
    for (const event of events) delivered.get(event.id)?.()
  } })
  const push = (event: Event) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { delivered.delete(event.id); reject(new Error(`Event ${event.id} was not flushed`)) }, 1000)
    delivered.set(event.id, () => { clearTimeout(timer); delivered.delete(event.id); resolve() })
    pending.push(event); wake()
  })
  try {
    await sleep(20); await recovered(s)
    await push(updated("m0002", "7:0:200")) // b arrives on the same, still open connection.
    expect(s.shown()).toEqual(["m0001", "m0003"])
    await push(updated("m0004", "7:0:400")) // Counterexample: committed after the read.
    expect(s.shown()).toEqual(["m0001", "m0003", "m0004"])
  } finally { pipeline.cleanup(); setImperativeSessionMessageLoader(null); s.done() }
})

test("only a replacing read sets the version; another journal and unstamped events are never dropped", async () => {
  const s = setup(); setImperativeSessionMessageLoader(s.loader)
  const apply = reducer(s)
  try {
    s.g.branch = ["m0001", "m0002"]; s.g.at = "7:0:100"; await s.loader.ensure(target, { reason: "navigation" })
    apply([updated("m0003", "7:0:50")]) // No replacing read yet: nothing to compare with, so it applies.
    expect(s.shown()).toContain("m0003")
    s.g.branch = ["m0001", "m0002", "m0003"]; s.g.at = "7:0:300"
    await s.loader.replaceHistory(target, undefined, new AbortController().signal)
    apply([updated("m0005", "7:0:400")]) // Newer than the replacing read: applies.
    apply([updated("m0006", "8:0:10")]) // Another journal (a replaced file): never compared,
    apply([updated("m0009", "7:1:10")]) // nor another rewrite of this one.
    apply([updated("m0008", "7:0:300")]) // Exactly the read's state: already reflected, dropped.
    expect(s.shown()).toEqual(["m0001", "m0002", "m0003", "m0005", "m0006", "m0009"])
    // An unstamped event for the session (an enrolled producer) applies and retires the mark: a stamped repair after it
    // (here a removal at the read's own state) applies too, rather than being taken as already reflected.
    apply([updated("m0007")])
    const stampedRemoval = { sessionID: target.sessionID, messageID: "m0007", smartyAt: "7:0:300" }
    apply([{ id: "evt_removed_m0007", type: "message.removed", properties: stampedRemoval }])
    expect(s.shown()).toEqual(["m0001", "m0002", "m0003", "m0005", "m0006", "m0009"])
    expect(s.store()!.getState().journalReads?.[target.sessionID]).toBeUndefined()
  } finally { setImperativeSessionMessageLoader(null); s.done() }
})

test("the mark belongs to the directory that replaced its history: another directory's events for the session apply", async () => {
  const s = setup(); setImperativeSessionMessageLoader(s.loader)
  try {
    s.g.branch = ["m0001", "m0003"]; s.g.at = "7:0:300"
    await s.loader.ensure(target, { reason: "navigation" }); await s.loader.replaceHistory(target, undefined, new AbortController().signal)
    expect(s.store()!.getState().journalReads?.[target.sessionID]).toBe("7:0:300")
    const other: State = { ...s.store()!.getState(), journalReads: undefined, message: { [target.sessionID]: [] }, part: {} } // Directory B's store.
    applyDirectoryEvent(other, updated("m0002", "7:0:200"))
    expect((other.message[target.sessionID] ?? []).map((m: { id: string }) => m.id)).toEqual(["m0002"])
  } finally { setImperativeSessionMessageLoader(null); s.done() }
})

test("an older page never moves the mark", async () => {
  const s = setup(); setImperativeSessionMessageLoader(s.loader)
  try {
    s.g.branch = Array.from({ length: 60 }, (_, i) => `m${String(i + 1).padStart(4, "0")}`); s.g.at = "7:0:300"
    await s.loader.ensure(target, { reason: "navigation" }); await s.loader.replaceHistory(target, undefined, new AbortController().signal)
    const reads = s.g.reads; s.g.at = "7:0:900"
    await s.loader.loadOlder(target)
    expect(s.g.reads).toBe(reads + 1) // An older page was read,
    expect(s.store()!.getState().journalReads?.[target.sessionID]).toBe("7:0:300") // and the mark stayed.
  } finally { setImperativeSessionMessageLoader(null); s.done() }
})

test("a mark retired by an unstamped event that changes nothing is still kept: the store is published", async () => {
  const s = setup(); setImperativeSessionMessageLoader(s.loader)
  try {
    s.g.branch = ["m0001"]; s.g.at = "7:0:300"
    await s.loader.ensure(target, { reason: "navigation" }); await s.loader.replaceHistory(target, undefined, new AbortController().signal)
    const draft = { ...s.store()!.getState() }
    const same: Event = { id: "evt_same", type: "message.updated", properties: { sessionID: target.sessionID, info: s.store()!.getState().message[target.sessionID]![0] } }
    expect(applyDirectoryEvent(draft, same)).toBeTruthy() // Nothing else changed, yet a change: published.
    expect(draft.journalReads?.[target.sessionID]).toBeUndefined()
  } finally { setImperativeSessionMessageLoader(null); s.done() }
})
