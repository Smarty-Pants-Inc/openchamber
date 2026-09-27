import type { Event } from "@opencode-ai/sdk/v2/client"
import { z } from "zod"

/**
 * View only sessions' message events, as the reducer sees them (smarty-code#455, openchamber#278). Two facts per session:
 * - a revision of its last applied live message event (sessionMessageEventCount): a history replacement read while it
 *   moved is older than the page (session-message-loader.ts);
 * - the journal state (`<ino>:<rewrite>:<offset>`, the gateway's stamp) of the directory's last history read that
 *   REPLACED what it shows (journalReads, set by the loader). An event stamped (`properties.smartyAt`) at or before it on
 *   the same journal and rewrite is already reflected: dropped, whichever socket, hub or buffer delayed it (review 11).
 *   An unstamped message event for the session (an enrolled producer) retires the mark.
 */
const sessionOwner = z.object({ sessionID: z.string().optional() })
const messageEvent = z.object({
  type: z.string().startsWith("message."),
  properties: z.object({
    sessionID: z.string().optional(),
    info: sessionOwner.optional(),
    part: sessionOwner.optional(),
    smartyAt: z.string().optional(),
  }),
})
const journalAt = z.string().regex(/^\d+:[\w.-]+:\d+$/).transform((stamp) => {
  const cut = stamp.lastIndexOf(":")
  return { journal: stamp.slice(0, cut), offset: Number(stamp.slice(cut + 1)) }
})
type JournalAt = z.infer<typeof journalAt>
type MessageEvent = { sessionID: string; at: JournalAt | undefined; stamped: boolean }

/** The session and journal stamp of a message event; undefined for any other event. */
function messageEventOf(event: Event): MessageEvent | undefined {
  const parsed = messageEvent.safeParse(event)
  if (!parsed.success) return undefined
  const { sessionID, info, part, smartyAt } = parsed.data.properties
  const owner = sessionID ?? info?.sessionID ?? part?.sessionID
  if (owner === undefined) return undefined
  const at = journalAt.safeParse(smartyAt)
  return { sessionID: owner, at: at.success ? at.data : undefined, stamped: smartyAt !== undefined }
}

const messageEvents = new Map<string, number>()
let messageRevision = 0
let evictedRevision = 0
/** Revisions only grow, and an evicted session reads as the highest evicted revision, so a session's value never returns
 * to an earlier one: eviction can only make a read stale, never a stale read clean. */
export const sessionMessageEventCount = (sessionID: string): number => messageEvents.get(sessionID) ?? evictedRevision

/** Counts an applied message event for its session (even one that changes nothing). */
export function countMessageEvent(event: Event): void {
  const message = messageEventOf(event)
  if (message === undefined) return
  messageEvents.delete(message.sessionID)
  messageRevision += 1
  messageEvents.set(message.sessionID, messageRevision) // Most recent last.
  if (messageEvents.size <= 1024) return
  const oldest = messageEvents.entries().next()
  if (oldest.done === true) return
  messageEvents.delete(oldest.value[0])
  evictedRevision = Math.max(evictedRevision, oldest.value[1])
}

/** What the reducer does with a message event, given the directory's replacing-read marks: `drop` it (already reflected),
 * or `apply` it with the marks it leaves (the same object when unchanged). */
export type JournalDecision = { drop: true } | { drop: false; marks: Readonly<Record<string, string>> | undefined }
export function journalDecision(marks: Readonly<Record<string, string>> | undefined, event: Event): JournalDecision {
  const message = messageEventOf(event)
  const mark = message === undefined || marks === undefined ? undefined : marks[message.sessionID]
  if (message === undefined || mark === undefined) return { drop: false, marks }
  if (!message.stamped) return { drop: false, marks: Object.fromEntries(Object.entries(marks ?? {}).filter(([id]) => id !== message.sessionID)) }
  const read = journalAt.safeParse(mark)
  const reflected = read.success && message.at !== undefined && read.data.journal === message.at.journal && message.at.offset <= read.data.offset
  return reflected ? { drop: true } : { drop: false, marks }
}

/** A reducer result, marked changed: a mark retired by an unstamped event is a store change even when the event itself
 * changed nothing, so the store is published and keeps it. */
export function changedResult<Detail extends { changed: boolean }>(result: boolean | Detail): true | Detail {
  return result === true || result === false ? true : { ...result, changed: true }
}
