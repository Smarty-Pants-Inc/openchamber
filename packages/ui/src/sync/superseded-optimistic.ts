import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { optimisticMessageRecords } from "./unsaved"

type MessageRecord = { info: Message; parts: Part[] }

/** ponytail: the browser's and the gateway's clocks differ a little; a real earlier message of the same text is older. */
const SAME_SEND_MS = 30_000

const textOf = (parts: readonly Part[]) => parts
  .flatMap((part) => part.type === "text" && !(part as { synthetic?: boolean }).synthetic ? [(part as { text?: string }).text ?? ""] : [])
  .join("").trim()
const createdOf = (info: Message) => (info as { time?: { created?: number } }).time?.created ?? 0

/**
 * smarty-code#1107: this page's optimistic user message whose own native entry is already shown. Until its client ID is
 * bound to the entry (the binding is written only after Pi saves it, slice 1 L1), the gateway shows the entry under its
 * native id, so for a moment one Send had two bubbles. The server's record with the same text, made at or after the
 * Send, takes the optimistic one's place; the optimistic record stays in the store (the send's confirmation still
 * settles it) and is only not shown.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  const server = records.filter((record) => record.info.role === "user" && !optimisticMessageRecords.has(record.info))
  if (server.length === 0) return records
  const kept = records.filter((record) => {
    if (record.info.role !== "user" || !optimisticMessageRecords.has(record.info)) return true
    const text = textOf(record.parts), since = createdOf(record.info) - SAME_SEND_MS
    return !text || !server.some((other) => createdOf(other.info) >= since && textOf(other.parts) === text)
  })
  return kept.length === records.length ? records : kept
}
