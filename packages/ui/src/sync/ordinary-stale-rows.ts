import type { Message } from "@opencode-ai/sdk/v2/client"
import type { DirectoryStore } from "./child-store"

/**
 * smarty-code#669 and #675: a page that missed live events (the gateway closes an event stream whose reader falls 1 MB
 * behind) keeps rows the gateway has since removed: a streamed reply's cut-off copy, or a sent message's first,
 * unlabelled copy. An ordinary (Pi) newest page is authoritative for its window, so a quiet read (no live message
 * event while it ran) drops every shown row newer than its oldest row that the page does not have. Kept: rows as old
 * as the page's oldest or older (history before the page), the page's own unsent messages (`keep`), and a reply still
 * streaming while the session works (pages never carry it, #127).
 */
export function withoutStaleOrdinaryRows(state: DirectoryStore, sessionID: string, page: readonly Message[],
  keep: (id: string) => boolean): DirectoryStore | null {
  if (page.length === 0) return null
  const pageIDs = new Set(page.map((message) => message.id))
  const oldest = Math.min(...page.map((message) => message.time.created))
  const working = state.session_status?.[sessionID]?.type !== "idle"
  const stale = (message: Message) => !pageIDs.has(message.id) && !keep(message.id) && message.time.created > oldest
    && !(working && message.role === "assistant" && message.time.completed === undefined)
  const shown = state.message[sessionID] ?? []
  const dropped = shown.filter(stale)
  if (dropped.length === 0) return null
  const part = { ...state.part }
  for (const message of dropped) delete part[message.id]
  return { ...state, message: { ...state.message, [sessionID]: shown.filter((message) => !stale(message)) }, part }
}
