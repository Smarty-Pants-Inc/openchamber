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
export function keepSavedState<T extends object>(existing: object, incoming: T): T {
  if (optimisticMessageRecords.has(existing) || !isStale(existing, incoming)) return incoming
  return { ...incoming, metadata: (existing as { metadata?: unknown }).metadata } as T
}

/**
 * Whether a history page's record for a row already shown should replace its metadata: never from an optimistic shadow
 * (not the server's word); always over an optimistic record; otherwise when the page is not older and says something
 * different (the save state or the revision).
 */
export function reconciledMetadata(existing: object, incoming: object): { adopt: boolean } {
  if (optimisticMessageRecords.has(incoming)) return { adopt: false }
  if (optimisticMessageRecords.has(existing)) return { adopt: true }
  if (isStale(existing, incoming)) return { adopt: false }
  return { adopt: isUnsaved(existing) !== isUnsaved(incoming) || revisionOf(existing) !== revisionOf(incoming) }
}
