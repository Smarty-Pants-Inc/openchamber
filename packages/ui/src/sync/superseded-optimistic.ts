import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { z } from "zod"
import { optimisticMessageRecords } from "./unsaved"
import { normalizeUserDisplayParts } from "../components/chat/message/normalizeUserDisplayParts"
import { filterVisibleParts, isEmptyTextPart, normalizeParts } from "../components/chat/message/partUtils"

type MessageRecord = { info: Message; parts: Part[] }

// Gateway linkage is outside the SDK type. Missing or malformed metadata proves nothing.
const echoSchema = z.object({
  metadata: z.object({ smartyCodeEchoOf: z.string().min(1).max(256) }),
})

// Immutable part buckets are replaced on arrival/update. Cache only content readiness,
// not linkage, so metadata updates still take effect with an unchanged parts reference.
const displayableByParts = new WeakMap<Part[], boolean>()

function hasDisplayableUserContent(parts: Part[]): boolean {
  const cached = displayableByParts.get(parts)
  if (cached !== undefined) return cached

  // Use the renderer's normalization and visibility rules. Disable optional views:
  // plan-mode-only text and reasoning cannot prove content is shown in every view.
  const normalized = normalizeUserDisplayParts(normalizeParts(parts), { planModeEnabled: false })
  const visible = filterVisibleParts(normalized, { includeReasoning: false })
  // Unknown part kinds are not readiness evidence. Empty text renders no user content;
  // files (including normalized linked-context attachments) can replace a bubble alone.
  const displayable = visible.some((part) => part.type === "file" || (part.type === "text" && !isEmptyTextPart(part)))
  displayableByParts.set(parts, displayable)
  return displayable
}

/**
 * Hide a pending bubble only while its explicitly linked native user entry has displayable content in the same session.
 * Linkage can arrive on any normal record update; text, timestamps and ID prefixes are not ownership evidence.
 * This is only a view projection: records, save metadata and optimistic confirmation remain untouched.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  if (!records.some((record) => record.info.role === "user" && optimisticMessageRecords.has(record.info))) return records

  const echoesBySession = new Map<string, Set<string>>()
  for (const { info, parts } of records) {
    if (info.role !== "user" || optimisticMessageRecords.has(info)) continue
    const echoOf = echoSchema.safeParse(info).data?.metadata.smartyCodeEchoOf
    if (echoOf === undefined || echoOf === info.id || !hasDisplayableUserContent(parts)) continue
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
