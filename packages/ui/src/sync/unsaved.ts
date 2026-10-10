import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import type { Message } from '@opencode-ai/sdk/v2/client';

/** True only when the server marks the record: Pi holds it in memory, but it is not in the session file yet. */
export const isUnsaved = (info: unknown): boolean =>
  (info as { metadata?: { smartyCodeUnsaved?: unknown } } | null | undefined)?.metadata?.smartyCodeUnsaved === true;

/** The page's own optimistic message records: they are not the server's word on whether Pi saved anything. */
export const optimisticMessageRecords = new WeakSet<object>()

/**
 * The gateway's freshness for a projected record (smarty-code#401): a whole number that never decreases for the same
 * row. Save state can move either way (a tool result that fails to append, or a journal that is replaced, makes a
 * saved row unsaved again), so freshness, not the direction of the change, decides which record is newer.
 */
const revisionOf = (info: unknown): number | undefined => {
  const value = (info as { metadata?: { smartyCodeRevision?: unknown } } | null | undefined)?.metadata?.smartyCodeRevision
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `incoming` is older than `existing` by the gateway's own ordering; without revisions nothing is known to be stale. */
const isStale = (existing: object, incoming: object): boolean => {
  const before = revisionOf(existing)
  const after = revisionOf(incoming)
  return before !== undefined && after !== undefined && after < before
}

/**
 * A record for a row already shown, from a live update, a reconnect page or a send confirmation. Its fields apply, but
 * an older record (a lower revision, for example a buffered event or a slow page) never replaces the shown record's
 * save state. An optimistic record is never the server's word, so a server record always replaces it.
 */
export function keepSavedState<T extends Message>(existing: Message, incoming: T): T {
  const shown: MessageMetadataView = existing
  const next = optimisticMessageRecords.has(existing) || !isStale(existing, incoming)
    ? incoming : { ...incoming, metadata: shown.metadata }
  return publishMessageMetadata(existing, next)
}

/**
 * Whether a history page's record for a row already shown should replace its metadata: never from an optimistic shadow
 * (not the server's word); always over an optimistic record; otherwise when the page is not older and says something
 * different (the save state, revision or validated author snapshot).
 */
export function reconciledMetadata(existing: object, incoming: object) {
  if (optimisticMessageRecords.has(incoming)) return { adopt: false }
  if (optimisticMessageRecords.has(existing)) return { adopt: true }
  if (isStale(existing, incoming)) return { adopt: false }
  if (isUnsaved(existing) !== isUnsaved(incoming) || revisionOf(existing) !== revisionOf(incoming)) return { adopt: true }
  // Compare the same schema-normalized snapshot HumanAuthor renders, not object identity or message text (#675).
  return { adopt: JSON.stringify(trustedHumanAuthor(existing)) !== JSON.stringify(trustedHumanAuthor(incoming)) }
}

type MessageMetadataView = Message & { metadata?: unknown }
// Record-lifetime sidecar, not an ID cache. It is neither persisted nor retained after its published record is released.
const metadataMutations = new WeakMap<Message, number>()
let metadataRevision = 0

/** O(1) read-local authority. Never look this baseline up again through a reused payload object (#675). */
export const messageMetadataRevision = (): number => metadataRevision

/** Carry the last metadata mutation through other-field replacements. A -> B -> A receives a new revision even when
 * A is a reused payload or published record. Copy metadata mutations so older published records keep their revision;
 * first insertion and non-metadata replacement retain the established incoming-reference contract. */
export function publishMessageMetadata<T extends Message>(existing: Message | undefined, incoming: T): T {
  if (optimisticMessageRecords.has(incoming) || existing === incoming) return incoming
  const changed = !existing || reconciledMetadata(existing, incoming).adopt
  const revision = existing && !changed ? metadataMutations.get(existing) ?? 0 : ++metadataRevision
  const published = changed && existing ? { ...incoming } : incoming
  metadataMutations.set(published, revision)
  return published
}

/** A page cannot replace metadata mutated since its numeric read baseline, including A -> B -> A. A paired higher
 * server revision still wins. Later reads can add, change or remove the author normally (#675). */
export function keepReadMetadata(existing: Message, incoming: Message, atRead: number): Message {
  if (optimisticMessageRecords.has(incoming)) return existing
  if (optimisticMessageRecords.has(existing)) return incoming
  const before = revisionOf(existing), after = revisionOf(incoming)
  if (before !== undefined && after !== undefined && after > before) return incoming
  if ((metadataMutations.get(existing) ?? 0) > atRead) return existing
  if (!isStale(existing, incoming)) return incoming
  const metadata: MessageMetadataView = existing
  const preserved = { ...incoming, metadata: metadata.metadata }
  return preserved
}
