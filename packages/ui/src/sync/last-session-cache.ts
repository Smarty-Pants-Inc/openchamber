import { z } from "zod"
import { getDeferredSafeStorage, getSafeSessionStorage } from "@/stores/utils/safeStorage"

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

// This tab's own latest choice per runtime, in sessionStorage: a session, or `null` for a deliberate
// draft. It wins over the shared pointer above, which any tab's selection or Send moves; a missing or malformed tab
// record falls back to the shared pointer (a fresh tab). Duplicated tabs inherit it, as they do composer draft slots.
const TAB_KEY_PREFIX = "oc.lastSession.tab.v1:"
const tabChoiceSchema = z.object({ sessionId: z.string().min(1), directory: z.string().min(1).nullable() }).nullable()

/** Which stores to use: defaults are shared + this tab; an injected shared store alone (tests) has no tab layer. */
const resolveStores = (storage?: Storage, tabStorage?: Storage): { shared: Storage; tab: Storage | undefined } =>
  storage ? { shared: storage, tab: tabStorage } : { shared: getDeferredSafeStorage(), tab: tabStorage ?? getSafeSessionStorage() }

/** This tab's choice: a session, `null` (a draft), or `undefined` when it has none (missing or malformed). */
const readTabChoice = (tab: Storage, runtimeKey: string): PersistedLastSession | null | undefined => {
  try {
    const raw = tab.getItem(TAB_KEY_PREFIX + runtimeKey)
    return raw === null ? undefined : tabChoiceSchema.safeParse(JSON.parse(raw)).data
  } catch {
    return undefined
  }
}

const writeTabChoice = (tab: Storage, runtimeKey: string, choice: PersistedLastSession | null): void => {
  const value = choice && { sessionId: choice.sessionId, directory: choice.directory || null }
  try {
    tab.setItem(TAB_KEY_PREFIX + runtimeKey, JSON.stringify(value))
  } catch {
    // Best effort, like the shared pointer: a blocked sessionStorage must never break session switching.
  }
}

export function persistLastActiveSession(
  runtimeKey: string,
  entry: PersistedLastSession,
  storage?: Storage,
  tabStorage?: Storage,
): void {
  if (!runtimeKey || !entry.sessionId) return
  const { shared, tab } = resolveStores(storage, tabStorage)
  if (tab) writeTabChoice(tab, runtimeKey, entry)
  const envelope = readEnvelope(shared)
  // Monotonic vs the stored entries: same-millisecond writes must not tie,
  // or retention trimming would evict an arbitrary runtime.
  const maxExisting = Object.values(envelope.runtimes).reduce((max, existing) => Math.max(max, existing.updatedAt), 0)
  envelope.runtimes[runtimeKey] = { ...entry, updatedAt: Math.max(Date.now(), maxExisting + 1) }
  writeEnvelope(shared, envelope)
}

export function readLastActiveSession(
  runtimeKey: string,
  storage?: Storage,
  tabStorage?: Storage,
): PersistedLastSession | null {
  if (!runtimeKey) return null
  const { shared, tab } = resolveStores(storage, tabStorage)
  const own = tab ? readTabChoice(tab, runtimeKey) : undefined
  if (own !== undefined) return own
  const entry = readEnvelope(shared).runtimes[runtimeKey]
  return entry ? { sessionId: entry.sessionId, directory: entry.directory } : null
}

/** A draft choice: this tab records `null` (even with no shared pointer), and the shared pointer is dropped. */
export function clearLastActiveSession(
  runtimeKey: string,
  storage?: Storage,
  tabStorage?: Storage,
): void {
  if (!runtimeKey) return
  const { shared, tab } = resolveStores(storage, tabStorage)
  const previous = readLastActiveSession(runtimeKey, shared, tab)
  if (tab) writeTabChoice(tab, runtimeKey, null)
  const envelope = readEnvelope(shared)
  if (envelope.runtimes[runtimeKey]) {
    delete envelope.runtimes[runtimeKey]
    writeEnvelope(shared, envelope)
  }
  if (previous) dropSessionRoute(previous.sessionId)
}

/** What the router knows now, when one registered (web only): whether it is still applying the page's route (a restore
 * pending; it ignores selection changes meanwhile), and the session the page shows. */
type RouteProbe = () => { applying: boolean; shown: string | null }
let routeProbe: RouteProbe | undefined
export function setShownSessionProbe(probe: RouteProbe | undefined): void { routeProbe = probe }

/**
 * The address bar must not keep what the pointer no longer means (smarty-code#113): a draft action clears the pointer,
 * but a pending restore's `?session=` stayed, and a reload restored that session over the draft. Only a session the
 * page does not show is dropped (its restore is cancelled); leaving a shown session is the router's own navigation,
 * with its history entry. An embedded session chat (`ocPanel`) keeps its fixed identity.
 */
function dropSessionRoute(sessionId: string): void {
  const win = globalThis.window, router = routeProbe?.()
  if (!router || !win?.history?.replaceState || (!router.applying && router.shown === sessionId)) return
  try {
    const url = new URL(win.location.href)
    // While the route is still being applied the address may name an earlier choice (A, then B selected, then a draft),
    // which the router has not synced yet: any session it names is then the cancelled restore.
    const routed = url.searchParams.get("session")
    if (url.searchParams.has("ocPanel") || !routed || (!router.applying && routed !== sessionId)) return
    url.searchParams.delete("session")
    win.history.replaceState(win.history.state, "", url)
  } catch { /* the address is best effort */ }
}

/** The runtime's last active session is still `sessionId`: nothing (a draft action, another choice) replaced it. */
export function isLastActiveSession(runtimeKey: string, sessionId: string, storage?: Storage, tabStorage?: Storage): boolean {
  return readLastActiveSession(runtimeKey, storage, tabStorage)?.sessionId === sessionId
}
