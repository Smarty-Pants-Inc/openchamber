import type { Session } from "@opencode-ai/sdk/v2"
import { Binary } from "./binary"
import { mergeOrdinaryModel, readOrdinaryModel } from '@/lib/opencode/ordinaryModel'

function areSessionsEqual(left: Session, right: Session): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function upsertSessionRecord(current: Session[], incoming: Session,
  revisions?: { requested: number; current: number }): Session[] {
  const result = Binary.search(current, incoming.id, (session) => session.id)
  if (revisions && revisions.requested !== revisions.current
    && (readOrdinaryModel(incoming) || (result.found && readOrdinaryModel(current[result.index])))) return current
  if (!result.found) return [...current.slice(0, result.index), incoming, ...current.slice(result.index)]
  // Equivalent authoritative detail must retain sidebar session-list references.
  incoming = mergeOrdinaryModel(current[result.index], incoming)
  if (areSessionsEqual(current[result.index], incoming)) return current
  const next = [...current]
  next[result.index] = incoming
  return next
}
