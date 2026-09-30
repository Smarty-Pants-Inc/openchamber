import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { isUnsaved, optimisticMessageRecords } from "./unsaved"

type MessageRecord = { info: Message; parts: Part[] }

const textOf = (parts: readonly Part[]) => parts
  .flatMap((part) => part.type === "text" && !(part as { synthetic?: boolean }).synthetic ? [(part as { text?: string }).text ?? ""] : [])
  .join("").trim()

/**
 * smarty-code#1107: this page's optimistic user message whose own native entry is already shown. Until Pi saves an entry,
 * the gateway shows it under its native id (an unsaved entry never takes the browser's alias, slice 1 L1), so for a
 * moment one Send had two bubbles. The server's unsaved record with the same text takes the optimistic one's place; the
 * optimistic record stays in the store (the send's confirmation still settles it) and is only not shown.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  const unsavedTexts = new Set(records.flatMap((record) => record.info.role === "user" && !optimisticMessageRecords.has(record.info)
    && isUnsaved(record.info) ? [textOf(record.parts)] : []).filter(Boolean))
  if (unsavedTexts.size === 0) return records
  const kept = records.filter((record) => !(record.info.role === "user" && optimisticMessageRecords.has(record.info)
    && unsavedTexts.has(textOf(record.parts))))
  return kept.length === records.length ? records : kept
}
