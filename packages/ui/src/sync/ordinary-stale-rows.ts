import type { Message } from "@opencode-ai/sdk/v2/client"
import type { DirectoryStore } from "./child-store"
import { z } from "zod"

/**
 * smarty-code#669 and #675: a page that missed live events (the gateway closes an event stream whose reader falls 1 MB
 * behind) keeps rows the gateway has since removed: a streamed reply's cut-off copy, or a sent message's first,
 * unlabelled copy. An ordinary (Pi) newest page is authoritative for its window, so a quiet read (no live message
 * event while it ran) drops every shown row newer than its oldest row that the page does not have (all of them when the
 * page is complete), and any first copy of an entry the page shows re-keyed, wherever it sits. Kept: rows as old as an
 * incomplete page's oldest or older (history before the page), the page's own unsent messages (`keep`), and a reply
 * still streaming while the session works (pages never carry it, #127). Idle drops unfinished replies outside the page
 * too (sync-context's interruptedTurnToolParts).
 */
export function withoutStaleOrdinaryRows(state: DirectoryStore, sessionID: string, page: readonly Message[],
  complete: boolean, keep: (id: string) => boolean): DirectoryStore | null {
  if (page.length === 0) return null
  const pageIDs = new Set(page.map((message) => message.id))
  // A saved entry the page shows under the sender's message ID: its first, unbound copy kept the entry's own ID.
  const reKeyed = new Set(page.flatMap((message) => { const entry = piEntryID(message); return entry && entry !== message.id ? [entry] : [] }))
  // A complete page is the whole history: nothing lies before it.
  const oldest = complete ? -Infinity : Math.min(...page.map((message) => message.time.created))
  const working = state.session_status?.[sessionID]?.type !== "idle"
  const stale = (message: Message) => !pageIDs.has(message.id) && !keep(message.id)
    && (reKeyed.has(message.id) || (message.time.created > oldest
      && !(working && message.role === "assistant" && message.time.completed === undefined)))
  const shown = state.message[sessionID] ?? []
  const dropped = shown.filter(stale)
  if (dropped.length === 0) return null
  const part = { ...state.part }
  for (const message of dropped) delete part[message.id]
  return { ...state, message: { ...state.message, [sessionID]: shown.filter((message) => !stale(message)) }, part }
}

/** The gateway's `metadata.pi.entryID` on a record: the Pi entry it shows (the SDK's Message type does not declare it). */
const PiEntry = z.object({ metadata: z.object({ pi: z.object({ entryID: z.string() }) }) })
const piEntryID = (message: Message) => PiEntry.safeParse(message).data?.metadata.pi.entryID
