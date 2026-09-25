import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"

// Persisted "last active session" per runtime (server instance), so a cold
// app launch can reopen the session the user had open the last time this
// instance was connected. This is startup-continuity context ONLY — callers
// must confirm the session still exists against an authoritative snapshot
// before opening it (see the MobileApp restore effect).
const STORAGE_KEY = "oc.lastSession.v1"
const MAX_RUNTIME_ENTRIES = 8

export type PersistedLastSession = {
  sessionId: string
  directory: string | null
}

type PersistedEntry = PersistedLastSession & { updatedAt: number }

type PersistedEnvelope = {
  version: 1
  runtimes: Record<string, PersistedEntry>
}

const emptyEnvelope = (): PersistedEnvelope => ({ version: 1, runtimes: {} })

const readEnvelope = (storage: Storage): PersistedEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>
    if (parsed.version !== 1 || !parsed.runtimes || typeof parsed.runtimes !== "object") return emptyEnvelope()
    const runtimes: Record<string, PersistedEntry> = {}
    for (const [runtimeKey, entry] of Object.entries(parsed.runtimes)) {
      if (!runtimeKey || !entry || typeof entry.sessionId !== "string" || entry.sessionId.length === 0) continue
      runtimes[runtimeKey] = {
        sessionId: entry.sessionId,
        directory: typeof entry.directory === "string" && entry.directory.length > 0 ? entry.directory : null,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      }
    }
    return { version: 1, runtimes }
  } catch {
    // Malformed persisted data is a read failure, not empty success — but for
    // a pure convenience cache the correct recovery is the same: start fresh.
    return emptyEnvelope()
  }
}

const writeEnvelope = (storage: Storage, envelope: PersistedEnvelope): void => {
  const retained = Object.entries(envelope.runtimes)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNTIME_ENTRIES)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, runtimes: Object.fromEntries(retained) }))
  } catch {
    // Best-effort cache — a full/blocked storage must never break session switching.
  }
}

export function persistLastActiveSession(
  runtimeKey: string,
  entry: PersistedLastSession,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!runtimeKey || !entry.sessionId) return
  const envelope = readEnvelope(storage)
  // Monotonic vs the stored entries: same-millisecond writes must not tie,
  // or retention trimming would evict an arbitrary runtime.
  const maxExisting = Object.values(envelope.runtimes).reduce((max, existing) => Math.max(max, existing.updatedAt), 0)
  envelope.runtimes[runtimeKey] = { ...entry, updatedAt: Math.max(Date.now(), maxExisting + 1) }
  writeEnvelope(storage, envelope)
}

export function readLastActiveSession(
  runtimeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): PersistedLastSession | null {
  if (!runtimeKey) return null
  const entry = readEnvelope(storage).runtimes[runtimeKey]
  return entry ? { sessionId: entry.sessionId, directory: entry.directory } : null
}

export function clearLastActiveSession(
  runtimeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!runtimeKey) return
  const envelope = readEnvelope(storage)
  const cleared = envelope.runtimes[runtimeKey]
  if (!cleared) return
  delete envelope.runtimes[runtimeKey]
  writeEnvelope(storage, envelope)
  dropSessionRoute(cleared.sessionId)
}

/** The session the page shows now, when a router registered one (web only). */
let shownSession: (() => string | null) | undefined
export function setShownSessionProbe(probe: (() => string | null) | undefined): void { shownSession = probe }

/**
 * The address bar must not keep what the pointer no longer means (smarty-code#113): a draft action clears the pointer,
 * but a pending restore's `?session=` stayed, and a reload restored that session over the draft. Only a session the
 * page does not show is dropped (its restore is cancelled); leaving a shown session is the router's own navigation,
 * with its history entry. An embedded session chat (`ocPanel`) keeps its fixed identity.
 */
function dropSessionRoute(sessionId: string): void {
  const win = globalThis.window
  if (!shownSession || !win?.history?.replaceState || shownSession() === sessionId) return
  try {
    const url = new URL(win.location.href)
    if (url.searchParams.has("ocPanel") || url.searchParams.get("session") !== sessionId) return
    url.searchParams.delete("session")
    win.history.replaceState(win.history.state, "", url)
  } catch { /* the address is best effort */ }
}

/** The runtime's last active session is still `sessionId`: nothing (a draft action, another choice) replaced it. */
export function isLastActiveSession(runtimeKey: string, sessionId: string, storage: Storage = getDeferredSafeStorage()): boolean {
  return readLastActiveSession(runtimeKey, storage)?.sessionId === sessionId
}
