import type { Event, Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

// #278 review 6: replaceHistory recoveries that overlap, fail, or are released never clobber each other's reset state.
export const target = { directory: "/repo", sessionID: "session-a" }
export type MessageRecord = { info: Message; parts: Part[] }
export const record = (id: string): MessageRecord => ({
  info: { id, sessionID: target.sessionID, role: "user", time: { created: Number(id.slice(1)) }, agent: "build",
    model: { providerID: "test", modelID: "test" } },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: "text", text: id }],
})
type MessagesInput = { limit?: number; before?: string }
type SessionMessages = OpencodeClient["session"]["messages"]
/** A fake SDK client whose `session.messages` serves `read`'s page as a successful response with `headers`. */
export function fakeMessagesClient(read: (input: MessagesInput) => Promise<{ data: MessageRecord[]; headers: Headers }>): OpencodeClient {
  // SAFETY: serves only the success shape the loader reads (`data`, `response.headers`; no `error` means success); the
  // loader never passes `throwOnError`, so the SDK method's other result shapes are never expected.
  const messages = (async (input: MessagesInput) => {
    const { data, headers } = await read(input)
    return { data, request: new Request("http://gateway.test/session/message"), response: new Response(null, { headers }) }
  }) as SessionMessages
  // SAFETY: a partial fake client; the loader under test only calls `sdk.session.messages`.
  return { session: { messages } } as OpencodeClient
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Gateway = { branch: string[]; reads: number; gates: (() => void)[]; holdNext: boolean; failNext: boolean; readOnly: boolean
  at: string | undefined }
/** A View only gateway whose reads can be held (`gate`) and can fail once (`failNext`). */
export function setup() {
  const g: Gateway = { branch: ["m0001", "m0002"], reads: 0, gates: [], holdNext: false, failNext: false, readOnly: true,
    at: undefined } // at: the journal state the next read reflects (x-smarty-journal-at, #278 r11).
  const messages = async ({ limit, before }: MessagesInput) => {
    const at = [...g.branch], readOnly = g.readOnly, journalAt = g.at; g.reads++
    if (g.failNext) { g.failNext = false; throw new Error("gateway unavailable") }
    if (g.holdNext) await new Promise<void>((resolve) => g.gates.push(resolve))
    const end = before ? at.indexOf(JSON.parse(atob(before)).before) : at.length, start = Math.max(0, end - (limit ?? at.length))
    const cursor = start > 0 ? btoa(JSON.stringify({ before: at[start] })) : null
    const headers = new Headers()
    if (readOnly) headers.set("x-smarty-read-only", "1")
    if (cursor !== null) headers.set("x-next-cursor", cursor)
    if (!before && journalAt !== undefined) headers.set("x-smarty-journal-at", journalAt)
    return { data: at.slice(start, end).map(record), headers }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: fakeMessagesClient(messages), runtimeKey: "runtime-a" })
  const store = () => childStores.getChild(target.directory)!
  const live = async (event: Event) => {
    const { applyDirectoryEvent } = await import("./event-reducer")
    const draft = { ...store().getState() }; applyDirectoryEvent(draft, event); store().setState(draft)
  }
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((message) => message.id)
  const done = () => { loader.dispose(); childStores.disposeAll() }
  return { g, loader, shown, done, live, store }
}
