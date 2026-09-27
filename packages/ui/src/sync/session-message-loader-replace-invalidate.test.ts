import { expect, test } from "bun:test"
import { record, setup, sleep, target } from "./session-message-loader-replace.fixture"

// #278 review 6 (local passes 4 and 6): a session invalidated, or a newer load started, while a recovery reads.

test("a session invalidated while a recovery reads ends the recovery: its late response is not applied", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.branch = ["m0001", "m0003"]; s.g.holdNext = true
    const recovering = s.loader.replaceHistory(target, [5])
    await sleep(5); s.g.holdNext = false
    s.loader.invalidateSession(target) // A deletion or an archive.
    s.g.gates.shift()?.(); await recovering
    expect(s.shown()).toEqual(["m0001", "m0002"]) // Not replaced by the late read,
    expect(s.loader.getSnapshot(target)).toMatchObject({ resolved: false }) // and still invalidated.
    const reads = s.g.reads; await sleep(30)
    expect(s.g.reads).toBe(reads) // No retry.
  } finally { s.done() }
})

test("a load started during a recovery's read is newer: the recovery never retires it", async () => {
  const s = setup()
  try {
    await s.loader.ensure(target, { reason: "navigation" })
    s.g.holdNext = true
    const recovering = s.loader.replaceHistory(target, [5]) // Its read is held,
    await sleep(5)
    s.g.branch = ["m0001", "m0002", "m0003"]
    const newer = s.loader.refreshTail(target, 50) // and a newer load is held too.
    await sleep(5); s.g.holdNext = false
    s.g.gates.shift()?.(); await sleep(5) // The recovery's read returns first: stale, nothing retired.
    s.g.gates.shift()?.(); await newer
    expect(s.shown()).toEqual(["m0001", "m0002", "m0003"]) // The newer load committed.
    await recovering // The retry then resets on a fresh read.
    expect(s.loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true })
  } finally { s.done() }
})

test("round 7: an old-branch event applied after the recovery commits is undone by the gateway's next tick", async () => {
  const s = setup()
  try {
    s.g.branch = ["m0001", "m0002"]; await s.loader.ensure(target, { reason: "navigation" }) // m0002: the old branch.
    s.g.branch = ["m0001", "m0003"]
    await s.loader.replaceHistory(target, [5]) // The recovery reads and commits the new branch first,
    expect(s.shown()).toEqual(["m0001", "m0003"])
    const late = { ...record("m0002").info }
    await s.live({ id: "evt_updated_m0002", type: "message.updated", properties: { sessionID: target.sessionID, info: late } }) // then a late frame,
    expect(s.shown()).toEqual(["m0001", "m0002", "m0003"])
    // and the tick of a gateway whose read left its baseline at the old branch (readOnlyReadBaseline) removes it.
    await s.live({ id: "evt_removed_m0002", type: "message.removed", properties: { sessionID: target.sessionID, messageID: "m0002" } })
    expect(s.shown()).toEqual(["m0001", "m0003"])
  } finally { s.done() }
})
