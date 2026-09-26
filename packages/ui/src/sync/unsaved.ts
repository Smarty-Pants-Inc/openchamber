/** True only when the server marks the record: Pi holds it in memory, but it is not in the session file yet. */
export const isUnsaved = (info: unknown): boolean =>
  (info as { metadata?: { smartyCodeUnsaved?: unknown } } | null | undefined)?.metadata?.smartyCodeUnsaved === true;

/** The page's own optimistic message records: they are not the server's word on whether Pi saved anything. */
export const optimisticMessageRecords = new WeakSet<object>()

/**
 * The metadata a shown record keeps when a history page brings `incoming` for it. Pi saving a record is final, so a page
 * may only clear the flag of a server-backed record (a page still saying unsaved may be older than a live update); a
 * server record always replaces an optimistic one, so the shown record stops being optimistic even when the flag is the
 * same; an optimistic shadow is never the server's word.
 */
/**
 * A live update for a record already shown. Pi saving a record is final: a server-backed record shown as saved keeps
 * its saved metadata even if an older buffered update says unsaved; every other field of the update applies.
 */
export function keepSavedState<T extends object>(existing: object, incoming: T): T {
  if (optimisticMessageRecords.has(existing) || isUnsaved(existing) || !isUnsaved(incoming)) return incoming
  return { ...incoming, metadata: (existing as { metadata?: unknown }).metadata } as T
}

export function reconciledMetadata(existing: object, incoming: object): { adopt: boolean } {
  if (optimisticMessageRecords.has(incoming)) return { adopt: false }
  if (optimisticMessageRecords.has(existing)) return { adopt: true }
  return { adopt: isUnsaved(existing) && !isUnsaved(incoming) }
}
