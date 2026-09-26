/** True only when the server marks the record: Pi holds it in memory, but it is not in the session file yet. */
export const isUnsaved = (info: unknown): boolean =>
  (info as { metadata?: { smartyCodeUnsaved?: unknown } } | null | undefined)?.metadata?.smartyCodeUnsaved === true;
