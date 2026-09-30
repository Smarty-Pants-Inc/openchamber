import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { z } from "zod"
import { optimisticMessageRecords } from "./unsaved"

type MessageRecord = { info: Message; parts: Part[] }

// Gateway linkage is outside the SDK type. Missing or malformed metadata proves nothing.
const echoSchema = z.object({
  metadata: z.object({ smartyCodeEchoOf: z.string().min(1).max(256) }),
})

/**
 * Hide a pending bubble only while its explicitly linked native user entry is shown in the same session.
 * Linkage can arrive on any normal record update; text, timestamps and ID prefixes are not ownership evidence.
 * This is only a view projection: records, save metadata and optimistic confirmation remain untouched.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  if (!records.some((record) => record.info.role === "user" && optimisticMessageRecords.has(record.info))) return records

  const echoesBySession = new Map<string, Set<string>>()
  for (const { info } of records) {
    if (info.role !== "user" || optimisticMessageRecords.has(info)) continue
    const echoOf = echoSchema.safeParse(info).data?.metadata.smartyCodeEchoOf
    if (echoOf === undefined || echoOf === info.id) continue
    let echoes = echoesBySession.get(info.sessionID)
    if (!echoes) {
      echoes = new Set<string>()
      echoesBySession.set(info.sessionID, echoes)
    }
    echoes.add(echoOf)
  }
  if (echoesBySession.size === 0) return records

  const shown = records.filter(({ info }) => info.role !== "user" || !optimisticMessageRecords.has(info)
    || !echoesBySession.get(info.sessionID)?.has(info.id))
  return shown.length === records.length ? records : shown
}
