import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { optimisticMessageRecords } from "./unsaved"

type MessageRecord = { info: Message; parts: Part[] }

/** ponytail: the browser's and the gateway's clocks differ a little; a real earlier message of the same text is older. */
const SAME_SEND_MS = 30_000

const textOf = (parts: readonly Part[]) => parts
  .flatMap((part) => part.type === "text" && !(part as { synthetic?: boolean }).synthetic ? [(part as { text?: string }).text ?? ""] : [])
  .join("").trim()
const createdOf = (info: Message) => (info as { time?: { created?: number } }).time?.created ?? 0
/** A record under a page's client ID (`msg_…`, session-actions `ascendingId`) is bound to its own Send already. */
const boundToClientID = (info: Message) => info.id.startsWith("msg_")

/**
 * smarty-code#1107: this page's optimistic user message whose own native entry is already shown. Until its client ID is
 * bound to the entry (the binding is written only after Pi saves it, slice 1 L1), the gateway shows the entry under its
 * native id, so for a moment one Send had two bubbles. One to one, oldest first: an unbound server record (native id)
 * with the same text, made at or after the Send, takes the place of at most one optimistic bubble of this tab. A record
 * already bound to a client ID (an earlier identical Send, another tab's) never does. The optimistic record stays in the
 * store (the send's confirmation still settles it) and is only not shown.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  const unbound = records.filter((record) => record.info.role === "user" && !optimisticMessageRecords.has(record.info)
    && !boundToClientID(record.info))
  if (unbound.length === 0) return records
  const byAge = (a: T, b: T) => createdOf(a.info) - createdOf(b.info)
  const used = new Set<T>(), hidden = new Set<T>()
  for (const mine of records.filter((record) => record.info.role === "user" && optimisticMessageRecords.has(record.info)).sort(byAge)) {
    const text = textOf(mine.parts), since = createdOf(mine.info) - SAME_SEND_MS
    const match = text ? [...unbound].sort(byAge).find((other) => !used.has(other) && createdOf(other.info) >= since && textOf(other.parts) === text) : undefined
    if (match) { used.add(match); hidden.add(mine); }
  }
  return hidden.size === 0 ? records : records.filter((record) => !hidden.has(record))
}
