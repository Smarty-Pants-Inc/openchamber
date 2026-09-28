import { expect, test } from "bun:test"
import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { withoutStaleOrdinaryRows } from "./ordinary-stale-rows"
import { fakeMessagesClient, target, type MessageRecord } from "./session-message-loader-replace.fixture"

// smarty-code#669 and #675 (3.40): a page that missed live events (its event stream was cut) kept rows the gateway had
// removed: a reply's cut-off streamed copy ("The running turn stopped..."), and a sent message's unlabelled first copy.
const S = target.sessionID
const user = (id: string, created: number): MessageRecord => ({
  info: { id, sessionID: S, role: "user", time: { created }, agent: "build", model: { providerID: "p", modelID: "m" } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: S, type: "text", text: id }],
})
const reply = (id: string, created: number, completed?: number): MessageRecord => ({
  info: { id, sessionID: S, role: "assistant", parentID: "u1", time: completed === undefined ? { created } : { created, completed },
    modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: S, type: "text", text: id }],
})
type Gateway = { page: MessageRecord[]; hold?: () => Promise<void> } // hold: runs while a read is served.
function gateway() {
  const g: Gateway = { page: [] }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { runtimeKey: "runtime-a", sdk: fakeMessagesClient(async () => {
    const served = structuredClone(g.page); await g.hold?.()
    const headers = new Headers(); headers.set("x-smarty-ordinary-view", `ov2_${"a".repeat(64)}`)
    return { data: served, headers }
  }) })
  const store = () => childStores.ensureChild(target.directory, { bootstrap: false })
  const live = async (event: Event) => {
    const { applyDirectoryEvent } = await import("./event-reducer")
    const draft = { ...store().getState() }; applyDirectoryEvent(draft, event); store().setState(draft)
  }
  const status = (type: "idle" | "busy") => store().setState((s) => ({ session_status: { ...s.session_status, [S]: { type } } }))
  const shown = () => (store().getState().message[S] ?? []).map((m) => m.id)
  return { g, loader, live, status, shown, done: () => { loader.dispose(); childStores.disposeAll() } }
}
const updated = (r: MessageRecord): Event => ({ id: `ev-${r.info.id}`, type: "message.updated", properties: { sessionID: S, info: r.info } })

test("#669: after the page missed a reply's removal, the quiet read at idle drops the cut-off copy", async () => {
  const s = gateway()
  try {
    s.g.page = [user("u1", 1)]; await s.loader.ensure(target, { reason: "navigation" })
    await s.live(updated(reply("live_1", 2))); await s.live(updated(reply("a1", 2, 3))) // Its removal never arrived.
    s.status("idle"); s.g.page = [user("u1", 1), reply("a1", 2, 3)]
    await s.loader.refreshOrdinaryView(target)
    expect(s.shown()).toEqual(["u1", "a1"])
  } finally { s.done() }
})

test("#675: after the page missed a sent message's re-key, the quiet read drops its unlabelled first copy", async () => {
  const s = gateway()
  try {
    s.g.page = [user("u1", 1)]; await s.loader.ensure(target, { reason: "navigation" })
    s.status("busy")
    await s.live(updated(user("e5", 5))); await s.live(updated(user("msg_c5", 5))) // e5's removal never arrived.
    s.g.page = [user("u1", 1), user("msg_c5", 5)]
    await s.loader.refreshOrdinaryView(target)
    expect(s.shown()).toEqual(["u1", "msg_c5"])
  } finally { s.done() }
})

test("counterexample: a reply still streaming while the session works stays (pages never carry it)", async () => {
  const s = gateway()
  try {
    s.g.page = [user("u1", 1)]; await s.loader.ensure(target, { reason: "navigation" })
    s.status("busy"); await s.live(updated(reply("live_1", 2)))
    await s.loader.refreshOrdinaryView(target)
    expect(s.shown()).toEqual(["u1", "live_1"])
  } finally { s.done() }
})

test("counterexample: a row that arrived while the read ran stays", async () => {
  const s = gateway()
  try {
    s.g.page = [user("u1", 1)]; await s.loader.ensure(target, { reason: "navigation" })
    s.status("idle"); s.g.hold = () => s.live(updated(user("u2", 4)))
    await s.loader.refreshOrdinaryView(target)
    expect(s.shown()).toEqual(["u1", "u2"])
  } finally { s.done() }
})

test("counterexample: rows older than the page and the page's own unsent messages stay", () => {
  const base = new ChildStoreManager().ensureChild("/a", { bootstrap: false }).getState()
  const idle: SessionStatus = { type: "idle" }
  const state = { ...base, session_status: { [S]: idle },
    message: { [S]: [user("old", 1).info, user("u5", 5).info, user("unsent", 6).info] } }
  expect(withoutStaleOrdinaryRows(state, S, [user("u5", 5).info], false, (id) => id === "unsent")).toBeNull()
})

// The gateway's user record: the entry it shows rides in metadata, which the SDK's Message type does not declare.
const bound = (id: string, entry: string, created: number): MessageRecord["info"] =>
  Object.assign(user(id, created).info, { metadata: { pi: { entryID: entry } } })
const shownState = (rows: MessageRecord["info"][]) => {
  const base = new ChildStoreManager().ensureChild("/a", { bootstrap: false }).getState()
  const idle: SessionStatus = { type: "idle" }
  return { ...base, session_status: { [S]: idle }, message: { [S]: rows } }
}
const ids = (state: ReturnType<typeof withoutStaleOrdinaryRows>) => state?.message[S]?.map((m) => m.id)

test("#675 (Astra r2): a complete page drops a raw copy at its oldest timestamp", () => {
  const state = shownState([user("e1", 1).info, bound("msg_c1", "e1", 1), reply("a2", 2, 3).info])
  expect(ids(withoutStaleOrdinaryRows(state, S, [bound("msg_c1", "e1", 1), reply("a2", 2, 3).info], true, () => false)))
    .toEqual(["msg_c1", "a2"])
})

test("#675 (Astra r2): an incomplete page drops the raw first copy of an entry it shows re-keyed, even at its oldest timestamp", () => {
  const state = shownState([user("old", 1).info, user("e3", 3).info, bound("msg_c3", "e3", 3)])
  expect(ids(withoutStaleOrdinaryRows(state, S, [bound("msg_c3", "e3", 3)], false, () => false))).toEqual(["old", "msg_c3"])
})
