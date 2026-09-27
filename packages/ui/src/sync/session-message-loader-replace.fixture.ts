import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

// #278 review 6: replaceHistory recoveries that overlap, fail, or are released never clobber each other's reset state.
export const target = { directory: "/repo", sessionID: "session-a" }
export const record = (id: string) => ({
  info: { id, sessionID: target.sessionID, role: "user", time: { created: Number(id.slice(1)) } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: "text", text: id }] as Part[],
})
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** A View only gateway whose reads can be held (`gate`) and can fail once (`failNext`). */
export function setup() {
  const g = { branch: ["m0001", "m0002"], reads: 0, gates: [] as (() => void)[], holdNext: false, failNext: false, readOnly: true,
    at: undefined as string | undefined } // at: the journal state the next read reflects (x-smarty-journal-at, #278 r11).
  const messages = async ({ limit, before }: { limit?: number; before?: string }) => {
    const at = [...g.branch], readOnly = g.readOnly, journalAt = g.at; g.reads++
    if (g.failNext) { g.failNext = false; throw new Error("gateway unavailable") }
    if (g.holdNext) await new Promise<void>((resolve) => g.gates.push(resolve))
    const end = before ? at.indexOf(JSON.parse(atob(before)).before) : at.length, start = Math.max(0, end - (limit ?? at.length))
    const cursor = start > 0 ? btoa(JSON.stringify({ before: at[start] })) : null
    const headers: Record<string, string | null> = { "x-smarty-read-only": readOnly ? "1" : null, "x-next-cursor": cursor,
      "x-smarty-journal-at": before ? null : journalAt ?? null }
    return { data: at.slice(start, end).map(record), response: { headers: { get: (name: string) => headers[name] ?? null } } }
  }
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: { session: { messages } } as unknown as OpencodeClient, runtimeKey: "runtime-a" })
  const store = () => childStores.getChild(target.directory)!
  const live = async (event: object) => {
    const { applyDirectoryEvent } = await import("./event-reducer")
    const draft = { ...store().getState() }; applyDirectoryEvent(draft as never, event as never); store().setState(draft)
  }
  const shown = () => (childStores.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map((message) => message.id)
  const done = () => { loader.dispose(); childStores.disposeAll() }
  return { g, loader, shown, done, live, store }
}

