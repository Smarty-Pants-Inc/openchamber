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
const nativeAliasSchema = z.object({ metadata: z.object({
  pi: z.object({ entryID: z.string().min(1).max(256) }),
  smartyCodeEchoOf: z.string().min(1).max(256).optional(),
  smartyVoice: z.object({ start: z.boolean().optional() }).optional(),
}) })

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
 * The following durable alias may then replace its raw native-ID representation once its content is displayable.
 * Exact same-session native-entry metadata proves representation identity, not receipt or author ownership.
 * Text, timestamps and ID prefixes prove nothing. This view leaves records, save metadata and confirmation untouched.
 */
export function withoutSupersededOptimistic<T extends MessageRecord>(records: T[]): T[] {
  const native = new Map<Message, z.infer<typeof nativeAliasSchema>["metadata"]>()
  const aliasesBySession = new Map<string, Map<string, { id: string; ready: boolean } | null>>()
  const echoesBySession = new Map<string, Set<string>>()
  for (const { info, parts } of records) {
    if (info.role !== "user" || optimisticMessageRecords.has(info)) continue
    const metadata = nativeAliasSchema.safeParse(info).data?.metadata
    if (metadata && !metadata.smartyVoice?.start) {
      native.set(info, metadata)
      if (info.id !== metadata.pi.entryID && metadata.smartyCodeEchoOf === undefined) {
        let aliases = aliasesBySession.get(info.sessionID)
        if (!aliases) aliasesBySession.set(info.sessionID, aliases = new Map())
        const entry = metadata.pi.entryID
        const previous = aliases.get(entry)
        aliases.set(entry, aliases.has(entry) && previous?.id !== info.id ? null
          : { id: info.id, ready: hasDisplayableUserContent(parts) })
      }
    }
    const echoOf = echoSchema.safeParse(info).data?.metadata.smartyCodeEchoOf
    if (echoOf === undefined || echoOf === info.id || !hasDisplayableUserContent(parts)) continue
    let echoes = echoesBySession.get(info.sessionID)
    if (!echoes) {
      echoes = new Set<string>()
      echoesBySession.set(info.sessionID, echoes)
    }
    echoes.add(echoOf)
  }
  if (echoesBySession.size === 0 && aliasesBySession.size === 0) return records

  const shown = records.filter(({ info }) => {
    if (info.role !== "user") return true
    if (optimisticMessageRecords.has(info)) return !echoesBySession.get(info.sessionID)?.has(info.id)
    const metadata = native.get(info), alias = aliasesBySession.get(info.sessionID)?.get(info.id)
    // Only two representations of the SAME native user entry; this does not bind input or infer an author.
    // A revoked marker may be absent. An explicit conflicting marker or competing aliases prove nothing.
    return !metadata || metadata.pi.entryID !== info.id || !alias?.ready
      || (metadata.smartyCodeEchoOf !== undefined && metadata.smartyCodeEchoOf !== alias.id)
  })
  return shown.length === records.length ? records : shown
}
