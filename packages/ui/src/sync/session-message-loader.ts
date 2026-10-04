import { keepSavedState, optimisticMessageRecords } from "./unsaved"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { isTransientError, retry } from "./retry"
import { sessionMessageEventCount } from "./event-reducer"
import { withoutStaleOrdinaryRows } from "./ordinary-stale-rows"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import { findMessageIndex, insertMessageChronologically, sortMessagesChronologically } from "./message-ordering"
import { stripMessageDiffSnapshots } from "./sanitize"
import { addRange, gapsOf, type Range } from "./position-windows"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import {
  clearDirectorySessionPrefetch,
  clearRuntimeSessionPrefetch,
  clearSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"
import { z } from "zod"
import { isVSCodeRuntime } from "@/lib/desktop"
import { failureReport, newOperationId, reportClientError } from "@/lib/clientErrorReport"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { normalizePath } from "@/lib/pathNormalization"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 50
const CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 100
const INITIAL_PAGE_EXPANSION_LIMITS = [100, 150] as const
const CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS = [50, 80, 120] as const

export type SessionMessageTarget = {
  directory: string
  sessionID: string
}

export type SessionMessageLoadKind = "initial" | "older" | "refresh" | "prefetch"
export type SessionMessageLoadStatus = "idle" | "loading" | "ready" | "error"

export type SessionMessageLoadState = {
  status: SessionMessageLoadStatus
  loadingKind: SessionMessageLoadKind | null
  error: Error | null
  resolved: boolean
  limit: number
  cursor: string | undefined
  complete: boolean
  generation: number
  updatedAt: number | undefined
  ordinaryView?: string
  /** Smarty gateway (#181): a fleet session shown view-only until it is enrolled. */
  readOnly?: boolean
  /**
   * smarty-code#583: the whole session as positions, when the gateway serves them (`x-smarty-total`): its record count
   * and the loaded ranges of positions. The page sizes the list to the whole session and loads the windows it shows.
   */
  positions?: SessionPositions
}

export type SessionPositions = { total: number; ranges: Range[]; epoch?: string }

type LoaderEntry = {
  target: SessionMessageTarget
  snapshot: SessionMessageLoadState
  listeners: Set<() => void>
  inflight: Promise<void> | null
  /** The open the page's reports name (#536): new on Try again (force) and after a success, so the page's automatic
   * reloads of one failed open are one error, however often they fail. */
  reportId: string
  /** Its open (a read of a session that never loaded) got no answer: the page's own reloads wait for Try again. */
  openUnanswered: boolean
  /** It has loaded once on this page: a later failure is a refresh's, never an open's (even after a disconnect). */
  loadedOnce: boolean
  queuedRefresh: Promise<void> | null
  queuedRefreshLimit: number
  /** smarty-code#583: each loaded message's position in the whole session, and the window reads in flight. */
  positionOf: Map<string, number>
  windowLoads: Map<string, Promise<void>>
  /** smarty-code#583: this session's pages come from range reads. */
  rangeReads: boolean
  /** smarty-code#583: bumped whenever a window read in flight must commit nothing (not by a same-epoch tail refresh). */
  windowGeneration: number
  optimistic: Map<string, OptimisticItem>
  ordinary: boolean
  resetHistory: boolean
  /** Pages committed to the store (replaceHistory: a reset read during which another load committed is stale). */
  commits: number
  /** Loads started or refreshes requested (replaceHistory: a reset read during which newer demand arose is stale). */
  demand: number
  /** The latest replaceHistory call; an older one's retries stop. */
  replaceEpoch: number
  ordinaryRefresh: Promise<void> | null
  ordinaryDemand: number
  /** smarty-code#827: the last view this page committed on this branch. A send revokes the accepted view (to refresh it),
   * but the gateway accepts an earlier view of the same branch, so the next send need not wait for that refresh. A reset
   * (a changed branch, a 409, a new runtime) clears it. */
  lastOrdinaryView?: string
  /** Each missing prompt a reload from the start already tried to load: never reloaded for again. */
  repairedPrompts?: Set<string>
  /** Reads that saw the session leave View only but were stale (a live event during the read), smarty-code#497. */
  leaveAttempts?: number
}

/** replaceHistory's retry delays after a stale read (then the last, repeated). */
const REPLACE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

type FetchedPage = {
  /** smarty-code#583: the position of the page's first record and the session's record count, when served. */
  at?: number
  total?: number
  indexEpoch?: string
  /** The page came from a range read (at=), which carries no cursor. */
  rangeRead?: boolean
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
  ordinaryView?: string
  readOnly: boolean
  viewEpoch: number
  /** The journal state a View only newest page reflects (`x-smarty-journal-at`, #278 r11). */
  journalAt?: string
  /** The session's live message-event revision when the read started (sessionMessageEventCount). */
  eventsAtRead: number
}

type LoadPerformanceDetails = {
  retryCount: number
  recordCount: number
}

type LoaderConfiguration = {
  sdk: OpencodeClient
  runtimeKey: string
}

const isConstrainedRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getInitialPageSize = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE
  : INITIAL_MESSAGE_PAGE_SIZE
const getInitialExpansionLimits = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS
  : INITIAL_PAGE_EXPANSION_LIMITS

// Wire shapes read here, decoded rather than narrowed field by field (anti-slop; same results as before).
const clientRoleSchema = z.object({ clientRole: z.string() })
const gatewayRecoverySchema = z.object({ name: z.literal("APIError"), data: z.object({ message: z.string().min(1) }) })
const errorMessageSchema = z.object({ message: z.string().min(1) })

const isUserMessage = (message: Message): boolean => {
  // OpenCode sends `clientRole` on the wire, outside the SDK type; a string there wins over `role`.
  const role = clientRoleSchema.safeParse(message).data?.clientRole ?? message.role
  return role === "user"
}

const hasUserMessage = (messages: Message[]): boolean => messages.some(isUserMessage)

/**
 * The Smarty gateway's deliberate recovery message (`{ name: 'APIError', data: { message } }`), the same
 * shape native creation trusts. Other bodies (proxy HTML, plain errors) are never shown to the user.
 */
export const gatewayRecoveryMessage = (cause: unknown): string | null =>
  gatewayRecoverySchema.safeParse(cause).data?.data.message ?? null

const formatSdkError = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  const text = z.string().safeParse(cause)
  if (text.success) return text.data
  return gatewayRecoveryMessage(cause)
    ?? errorMessageSchema.safeParse(cause).data?.message
    ?? "Session messages could not be loaded"
}

/**
 * Nothing answered this read, and asking again at once will not help: the client's own read limit ran out, or the
 * gateway says its read of the Pi timed out (code smarty.pi-timed-out: a frozen Pi). Any other failure keeps its tries.
 * An open stops at the first unanswered read, and the page's own reloads wait for the person (#536).
 */
const PI_TIMED_OUT = "smarty.pi-timed-out"
const unanswered = (error: Error): boolean => /timed out/i.test(error.message)
  || ("code" in error && error.code === PI_TIMED_OUT)

// The gateway's stable refusal code, when its error carries one (smarty-code errors.ts).
const GatewayCode = z.object({ data: z.object({ code: z.string().optional() }) })

const assertSdkSuccess = (result: {
  error?: unknown
  response?: { status?: number }
}, operation: string): void => {
  if (!result.error) return
  const status = result.response?.status
  const message = `${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`
  // The cause keeps the fetch's own error (an AbortError, a TypeError) for the client-error report (smarty-code#1058).
  throw Object.assign(new Error(message, { cause: result.error }), { status, code: GatewayCode.safeParse(result.error).data?.data.code,
    serverMessage: gatewayRecoveryMessage(result.error) ?? undefined })
}

/** A read the loader itself gave up: its view was read across a stream reconnect, or its owner cancelled it. When a newer
 * read took over, the load is stale and not reported; when the load is still current it failed for the person (the open
 * used up its replacement reads): reported as `SupersededReadError (superseded-exhausted)` (smarty-code#1058 r1). */
export class SupersededReadError extends Error {
  override name = "SupersededReadError"
}

const filterIdentifiedParts = (parts: Part[]): Part[] => parts
  .filter((part) => Boolean(part?.id))

const createDefaultState = (generation = 0): SessionMessageLoadState => ({
  status: "idle",
  loadingKind: null,
  error: null,
  resolved: false,
  limit: getInitialPageSize(),
  cursor: undefined,
  complete: false,
  generation,
  updatedAt: undefined,
})

export const EMPTY_SESSION_MESSAGE_LOAD_STATE = createDefaultState()

export class SessionMessageLoader {
  private sdk: OpencodeClient
  private runtimeKey: string
  private sdkEpoch = 0
  private ordinaryEpoch = 0
  private disposed = false
  private readonly entries = new Map<string, LoaderEntry>()

  constructor(
    private readonly childStores: ChildStoreManager,
    configuration: LoaderConfiguration,
  ) {
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
  }

  configure(configuration: LoaderConfiguration): void {
    if (this.sdk === configuration.sdk && this.runtimeKey === configuration.runtimeKey) return
    const runtimeChanged = this.runtimeKey !== configuration.runtimeKey
    const previousRuntimeKey = this.runtimeKey
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      entry.snapshot = {
        ...entry.snapshot,
        status: entry.snapshot.resolved ? "ready" : "idle",
        loadingKind: null,
        error: null,
        ordinaryView: undefined,
        generation: entry.snapshot.generation + 1,
      }
      entry.lastOrdinaryView = undefined
      entry.windowGeneration++ // A new connection: windows read over the old one commit nothing.
      entry.inflight = null
      entry.openUnanswered = false // A new connection (re-login, reconnect) may answer: the page's reloads may try again.
      if (entry.ordinary) this.invalidateOrdinaryView(entry.target, true)
      this.notify(entry)
    }
    if (runtimeChanged) {
      this.entries.clear()
      clearRuntimeSessionPrefetch(previousRuntimeKey)
    }
  }

  /**
   * Re-enable a loader which was disposed by a transient React effect cleanup.
   *
   * React Strict Mode runs effect setup, cleanup, then setup again in
   * development. The provider owns one ref-stable loader across that sequence,
   * so the second setup must be able to accept new work after the first cleanup
   * invalidated its in-flight requests.
   */
  activate(): void {
    this.disposed = false
  }

  initializeCreatedSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const current = store.getState()
    // The create response establishes an empty transcript, but events or a
    // prompt may already have materialized a newer snapshot while it travelled.
    if (current.message[normalized.sessionID] !== undefined) return
    const entry = this.getEntry(normalized)
    this.bumpGeneration(entry)
    entry.inflight = null
    store.setState({ message: { ...current.message, [normalized.sessionID]: [] } })
    this.patchEntry(entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      cursor: undefined,
      complete: true,
      updatedAt: Date.now(),
    })
    this.persistCoverage(normalized, entry.snapshot)
  }

  ensure(
    target: SessionMessageTarget,
    options?: { force?: boolean; reason?: "navigation" | "reactive" | "prefetch" },
  ): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const materialization = getSessionMaterializationStatus(store.getState(), normalized.sessionID)
    // Opening it: a page that claimed the whole history while the store now holds a reply without its prompt (streamed
    // after that page) is stale coverage. The timeline hides such a reply, so the session would open empty (#126 item 4):
    // it is loaded again from the start, so its pages, cursor and completeness are re-established.
    const staleCoverage = !options?.force && options?.reason === "navigation" && entry.snapshot.resolved
      && entry.snapshot.complete && hasReplyWithoutPrompt(store.getState(), normalized.sessionID)
    const force = options?.force === true || staleCoverage
    // An open that got no answer stays failed until the person asks again (Try again, or opening it anew): the page's own
    // effects re-ensure on every session update, and each would start another 30 s read behind the skeleton (#536).
    if (!force && options?.reason !== "navigation" && this.openUnanswered(entry)) return Promise.resolve()
    if (!force && materialization.renderable && entry.snapshot.resolved
      && (!entry.ordinary || entry.snapshot.ordinaryView)) {
      return entry.inflight ?? Promise.resolve()
    }
    if (entry.inflight) {
      if (options?.reason !== "prefetch" && entry.snapshot.loadingKind === "prefetch") {
        this.patchEntry(entry, { loadingKind: "initial" })
      }
      return entry.inflight
    }
    if (entry.ordinary && entry.snapshot.resolved && !force) {
      return this.refreshTail(normalized, getInitialPageSize())
    }
    if (force) { this.bumpGeneration(entry); entry.reportId = newOperationId() } // Try again: a new open.
    const kind: SessionMessageLoadKind = options?.reason === "prefetch" ? "prefetch" : "initial"
    return this.startLoad(normalized, entry, store, kind, async (isCurrent, performance) => {
      await this.loadInitial(normalized, entry, store, isCurrent, performance)
    })
  }

  prefetch(target: SessionMessageTarget): Promise<void> {
    return this.ensure(target, { reason: "prefetch" })
  }

  loadOlder(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) return entry.inflight.then(() => this.loadOlder(normalized))
    // With positions (smarty-code#583) an older page is the window just before the first loaded range.
    const first = entry.snapshot.positions?.ranges[0]
    if (first) return first.start > 0 ? this.loadAt(normalized, Math.max(0, first.start - HISTORY_MESSAGE_PAGE_SIZE),
      first.start - Math.max(0, first.start - HISTORY_MESSAGE_PAGE_SIZE)) : Promise.resolve()
    if (entry.snapshot.complete || !entry.snapshot.cursor) return Promise.resolve()
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const cursor = entry.snapshot.cursor
    return this.startLoad(normalized, entry, store, "older", async (isCurrent, performance) => {
      const page = await this.fetchPage(normalized, HISTORY_MESSAGE_PAGE_SIZE, cursor, "older", performance)
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, store, page, "prepend", isCurrent)
      if (!committed || !isCurrent()) return
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: Math.max(entry.snapshot.limit, committed.messages.length),
        cursor: page.cursor,
        complete: page.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  async loadComplete(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) throw new Error("Session message loader is unavailable")
    const initial = this.getSnapshot(normalized)
    await this.ensure(normalized, { force: !initial.resolved })

    const visitedCursors = new Set<string>()
    let stalls = 0, lastCoverage = ""
    while (true) {
      const snapshot = this.getSnapshot(normalized)
      if (snapshot.status === "error") throw snapshot.error ?? new Error("Session history could not be loaded")
      if (snapshot.complete) return
      // smarty-code#583: with positions (range reads carry no cursor) fill each missing range up to the loaded end, from
      // the oldest. A newest page read while the index was building has no positions: read it again to learn them.
      if (snapshot.positions || (!snapshot.cursor && this.servesPositions(normalized))) {
        const ranges = snapshot.positions?.ranges ?? []
        const coverage = JSON.stringify(snapshot.positions ?? null)
        stalls = coverage === lastCoverage ? stalls + 1 : 0
        lastCoverage = coverage
        if (stalls >= 3) throw new Error("Session history pagination made no progress")
        if (!ranges.length) {
          await this.refreshTail(normalized, Math.min(500, Math.max(HISTORY_MESSAGE_PAGE_SIZE, snapshot.limit)))
          continue
        }
        const hole = gapsOf(ranges, ranges[ranges.length - 1]!.end)[0]
        if (!hole) return
        await this.loadAt(normalized, hole.start, Math.min(500, hole.end - hole.start))
        continue
      }
      if (!snapshot.cursor) throw new Error("Session history coverage is unresolved")
      if (visitedCursors.has(snapshot.cursor)) {
        throw new Error("Session history pagination made no progress")
      }
      visitedCursors.add(snapshot.cursor)

      await this.loadOlder(normalized)
    }
  }

  /** An open (never loaded) whose read timed out: it waits for the person's Try again, not the page's own reloads. */
  private openUnanswered(entry: LoaderEntry): boolean {
    return !entry.inflight && entry.openUnanswered
  }

  refreshTail(target: SessionMessageTarget, limit: number): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    // Nothing loaded to refresh, and the open timed out (also a refresh queued behind that open): wait for Try again.
    if (this.openUnanswered(entry)) return Promise.resolve()
    if (entry.inflight) {
      entry.queuedRefreshLimit = Math.max(entry.queuedRefreshLimit, limit)
      entry.demand++
      if (entry.queuedRefresh) return entry.queuedRefresh
      const inflight = entry.inflight
      const entryKey = this.keyFor(normalized)
      const generation = entry.snapshot.generation
      const sdkEpoch = this.sdkEpoch
      const clearQueuedRefresh = () => {
        if (entry.queuedRefresh !== queuedRefresh) return
        entry.queuedRefresh = null
        entry.queuedRefreshLimit = 0
      }
      const queuedRefresh = inflight.then(() => {
        if (
          this.disposed
          || this.sdkEpoch !== sdkEpoch
          || entry.snapshot.generation !== generation
          || this.entries.get(entryKey) !== entry
        ) {
          clearQueuedRefresh()
          return
        }
        const refreshLimit = entry.queuedRefreshLimit
        clearQueuedRefresh()
        return this.refreshTail(normalized, refreshLimit)
      })
      entry.queuedRefresh = queuedRefresh
      return queuedRefresh
    }
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    this.bumpGeneration(entry, true)
    return this.startLoad(normalized, entry, store, "refresh", async (isCurrent, performance) => {
      const previousCoverage = entry.snapshot.resolved
        ? { cursor: entry.snapshot.cursor, complete: entry.snapshot.complete }
        : null
      const page = await this.fetchPage(normalized, Math.max(1, limit), undefined, "refresh", performance)
      if (!isCurrent()) return
      // The first tail page after the session left View only replaces what was shown, as a first open, with its own
      // coverage (smarty-code#497): merged into the View only coverage it could leave a gap marked complete. Like
      // replaceHistory, a read during which a live event for the session was applied is older than the page: it commits
      // nothing, and another read follows with a backoff. (A full initial load already adopts its own page's coverage.)
      const leaving = leavesViewOnly(entry, page, "merge")
      const stale = leaving && page.eventsAtRead !== sessionMessageEventCount(normalized.sessionID)
      if (leaving && !stale) entry.resetHistory = true
      const committed = stale ? null : this.commitPage(normalized, entry, store, page, "merge", isCurrent)
      if (stale && isCurrent()) {
        const attempt = entry.leaveAttempts = (entry.leaveAttempts ?? 0) + 1
        this.patchEntry(entry, { status: "ready", loadingKind: null })
        const delay = REPLACE_RETRY_MS[Math.min(attempt - 1, REPLACE_RETRY_MS.length - 1)] ?? 30_000
        setTimeout(() => { if (isCurrent()) void this.refreshTail(normalized, limit) }, delay)
        return
      }
      if (!committed || !isCurrent()) return
      if (leaving) entry.leaveAttempts = 0
      // A tail page that is not the whole history, while the earlier page claimed it was and a reply now lacks its prompt,
      // proves that claim stale (the session grew after it): its own cursor is the coverage now, so older pages load and
      // the timeline shows the replies (#126 item 4). Otherwise the earlier coverage stays, as before.
      const staleCoverage = previousCoverage?.complete === true && !page.complete
        && hasReplyWithoutPrompt(store.getState(), normalized.sessionID)
      const coverage = staleCoverage || leaving ? page : previousCoverage ?? page
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: leaving ? committed.messages.length : Math.max(entry.snapshot.limit, committed.messages.length),
        // A tail refresh uses a deliberately small window. Its cursor only
        // describes that window, so it must not replace the established
        // history coverage and spuriously expose "load older".
        // smarty-code#583 (openchamber#363 r13): with positions, coverage is what the positions say after this commit
        // (notePositions): a tail that found a new index epoch replaced the history, so the old epoch's completeness
        // must not come back (an export would then stop at the tail).
        cursor: entry.snapshot.positions ? entry.snapshot.cursor : coverage.cursor,
        complete: entry.snapshot.positions ? entry.snapshot.complete : coverage.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  /**
   * Replaces a session's shown history with a fresh newest page, as on a first open: the page's own cursor and
   * completeness, older pages then load normally from there. A View only watch re-acquired after entries it missed
   * (openchamber#278): a merged tail page would keep the old coverage and leave gaps or a branch that no longer exists.
   */
  async replaceHistory(target: SessionMessageTarget, retryMs: readonly number[] = REPLACE_RETRY_MS, signal?: AbortSignal): Promise<void> {
    const normalized = this.normalizeTarget(target)
    const entry = normalized ? this.entries.get(this.keyFor(normalized)) : undefined
    if (!normalized || !entry || this.disposed || signal?.aborted || entry.ordinary) return // Released: never supersedes.
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    // Its own read, apart from the loader's loads: the page and its coverage stay exactly as they are until one
    // synchronous commit. A read during which a live event for the session was applied, or another load committed, is
    // older than the page: nothing is applied (never a merge, never an erase), and another read follows with a backoff.
    // A newer replacement, `signal` (the watch released) or a disposed loader ends it, before any commit or request.
    // An event applied only after the commit (the pipeline batches them, and the stream and this read are separate
    // connections) converges: View only events are full-state only, and the gateway tail publishes anything a read saw
    // beyond its baseline at its next tick, because a read never moves that baseline (the gateway's readOnlyReadBaseline
    // capability, smarty-code#507; view-only-watch.ts watches only such a gateway).
    const epoch = ++entry.replaceEpoch
    const owns = () => !this.disposed && !signal?.aborted && entry.replaceEpoch === epoch
      && this.entries.get(this.keyFor(normalized)) === entry && this.childStores.getChild(normalized.directory) === store
    for (let attempt = 0; owns(); attempt++) {
      const events = sessionMessageEventCount(normalized.sessionID), commits = entry.commits, demand = entry.demand
      const page = await this.fetchPage(normalized, getInitialPageSize(), undefined, "refresh", undefined, () => !owns())
        .catch(() => null)
      if (!owns() || entry.ordinary) return // Another load adopted an ordinary view: the session left View only.
      // It left View only: the ordinary loading path owns that transition, including its coverage (smarty-code#497).
      if (page && (!page.readOnly || page.ordinaryView)) return
      // Newer demand (a load started or a refresh requested during the read) is never retired: this read is stale.
      if (page && events === sessionMessageEventCount(normalized.sessionID) && commits === entry.commits
        && demand === entry.demand) {
        // A load still reading, or queued, is older than this reset: it no longer commits. A load started while the reset
        // publishes (by a subscriber) waits behind a barrier until the new coverage is set, then starts from it.
        this.bumpGeneration(entry)
        entry.queuedRefresh = null
        entry.queuedRefreshLimit = 0
        let release = () => {}
        const barrier = entry.inflight = new Promise<void>((resolve) => { release = resolve })
        let committed: { messages: Message[] } | null = null
        try {
          entry.resetHistory = true
          committed = this.commitPage(normalized, entry, store, page, "merge", () => true)
          if (committed) {
            this.patchEntry(entry, { status: "ready", loadingKind: null, error: null, resolved: true, cursor: page.cursor,
              complete: page.complete, limit: committed.messages.length, updatedAt: Date.now() })
            this.persistCoverage(normalized, entry.snapshot)
          }
        } finally {
          entry.resetHistory = false
          if (entry.inflight === barrier) entry.inflight = null
          release()
        }
        if (committed) return
      }
      const delay = retryMs[Math.min(attempt, retryMs.length - 1)] ?? 30_000
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve() }
        const timer = setTimeout(done, delay)
        signal?.addEventListener("abort", done, { once: true })
      })
    }
  }

  getAcceptedOrdinaryView(target: SessionMessageTarget, runtimeKey: string): string | undefined {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed || runtimeKey !== this.runtimeKey) return undefined
    const entry = this.entries.get(this.keyFor(normalized))
    // A plain tail refresh keeps the last accepted view until it commits: a new session's first idle refreshes its
    // tail right as its first message goes, and withdrawing the view meanwhile refused that Send ("could not be loaded",
    // slice 1 step 6 on the candidate). A changed view replaces it on commit; a failed read or a reset revokes it.
    const refreshing = entry?.snapshot.status === "loading" && entry.snapshot.loadingKind === "refresh" && entry.snapshot.resolved
    return entry?.snapshot.status === "ready" || refreshing ? entry?.snapshot.ordinaryView : undefined
  }

  /** smarty-code#827: the view a send may carry now: the accepted one, else the last one committed on this branch (a
   * send's own revocation keeps it; a reset clears it). Undefined only when the page has no view of this branch. */
  getSendableOrdinaryView(target: SessionMessageTarget, runtimeKey: string): string | undefined {
    const accepted = this.getAcceptedOrdinaryView(target, runtimeKey)
    if (accepted) return accepted
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed || runtimeKey !== this.runtimeKey) return undefined
    return this.entries.get(this.keyFor(normalized))?.lastOrdinaryView
  }

  /** True once this session's history was served as an ordinary (view-guarded) transcript. */
  isOrdinary(target: SessionMessageTarget, runtimeKey: string): boolean {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed || runtimeKey !== this.runtimeKey) return false
    return this.entries.get(this.keyFor(normalized))?.ordinary === true
  }

  invalidateOrdinaryView(target: SessionMessageTarget, resetHistory = false): boolean {
    const normalized = this.normalizeTarget(target)
    const entry = normalized ? this.entries.get(this.keyFor(normalized)) : undefined
    if (!entry?.ordinary || this.disposed) return false
    this.bumpGeneration(entry)
    entry.inflight = null
    entry.resetHistory ||= resetHistory
    const patch: Partial<SessionMessageLoadState> = {
      ordinaryView: undefined,
      loadingKind: null,
      status: entry.snapshot.resolved ? "ready" : "idle",
    }
    if (resetHistory) {
      entry.lastOrdinaryView = undefined
      patch.status = "idle"
      patch.resolved = false
      patch.cursor = undefined
      patch.complete = false
    }
    this.patchEntry(entry, patch)
    if (normalized) clearSessionPrefetch(normalized.directory, [normalized.sessionID], this.runtimeKey)
    return true
  }

  /** The event stream reconnected: a timed-out open may answer now, so the page's own reloads may try it again. */
  connectionRestored(): void {
    for (const entry of this.entries.values()) entry.openUnanswered = false
  }

  invalidateOrdinaryViews(): void {
    this.ordinaryEpoch += 1
    for (const entry of this.entries.values()) {
      // smarty-code#827: a lost or switched event stream is no changed branch. History is re-read from the start, but
      // the last view stays sendable: under load the stream stalls and reconnects, and a send then had no view and sat
      // for the whole 5 s re-read before being refused. The gateway still refuses a view its branch has moved past
      // (409, re-read and resent once).
      const last = entry.lastOrdinaryView
      this.invalidateOrdinaryView(entry.target, true)
      entry.lastOrdinaryView = last
    }
  }

  refreshOrdinaryView(target: SessionMessageTarget, resetHistory = false): Promise<void> {
    const normalized = this.normalizeTarget(target)
    const entry = normalized ? this.entries.get(this.keyFor(normalized)) : undefined
    if (!normalized || !entry?.ordinary || this.disposed) return Promise.resolve()
    if (resetHistory) {
      // smarty-code#827: an event reset (a removed row: while an agent works the gateway removes its live rows all the
      // time, or an error) re-reads history from the start but is no changed branch: the last view stays sendable, so a
      // steer does not sit through that re-read. The gateway refuses a view its branch moved past (409, re-read, resent).
      const last = entry.lastOrdinaryView
      this.invalidateOrdinaryView(normalized, true)
      entry.lastOrdinaryView = last
    }
    entry.ordinaryDemand += 1
    if (entry.ordinaryRefresh) return entry.ordinaryRefresh
    const sdkEpoch = this.sdkEpoch
    const refresh = Promise.resolve().then(async () => {
      while (!this.disposed && this.sdkEpoch === sdkEpoch && this.entries.get(this.keyFor(normalized)) === entry) {
        const demand = entry.ordinaryDemand
        await this.refreshTail(normalized, getInitialPageSize())
        if (entry.ordinaryDemand === demand) return
      }
    }).finally(() => {
      if (entry.ordinaryRefresh === refresh) entry.ordinaryRefresh = null
    })
    entry.ordinaryRefresh = refresh
    return refresh
  }

  /**
   * This page holds (or is loading) the session's history: a load resolved or in flight, or a prefetched page. An entry
   * that only a snapshot read created holds nothing. Never creates an entry.
   */
  holdsHistory(target: SessionMessageTarget): boolean {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return false
    const entry = this.entries.get(this.keyFor(normalized))
    if (entry && (entry.snapshot.resolved || entry.inflight)) return true
    return getSessionPrefetch(normalized.directory, normalized.sessionID, this.runtimeKey) !== undefined
  }

  getSnapshot(target: SessionMessageTarget): SessionMessageLoadState {
    const normalized = this.normalizeTarget(target)
    return normalized ? this.getEntry(normalized).snapshot : EMPTY_SESSION_MESSAGE_LOAD_STATE
  }

  subscribe(target: SessionMessageTarget, listener: () => void): () => void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return () => undefined
    const entry = this.getEntry(normalized)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  optimisticAdd(input: SessionMessageTarget & { message: Message; parts: Part[] }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    optimisticMessageRecords.add(input.message)
    entry.optimistic.set(input.message.id, { message: input.message, parts: filterIdentifiedParts(input.parts) })
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = current.message[target.sessionID] ? [...current.message[target.sessionID]] : []
    if (findMessageIndex(messages, input.message.id) < 0) {
      insertMessageChronologically(messages, input.message)
    }
    store.setState({
      message: { ...current.message, [target.sessionID]: messages },
      part: { ...current.part, [input.message.id]: filterIdentifiedParts(input.parts) },
    })
  }

  optimisticRemove(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.delete(input.messageID)
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const existing = current.message[target.sessionID]
    const messages = existing ? existing.filter((message) => message.id !== input.messageID) : undefined
    const part = { ...current.part }
    delete part[input.messageID]
    const next: Partial<DirectoryStore> = { part }
    if (messages) next.message = { ...current.message, [target.sessionID]: messages }
    store.setState(next)
  }

  optimisticConfirm(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    this.getEntry(target).optimistic.delete(input.messageID)
  }

  invalidateSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return
    const entry = this.entries.get(this.keyFor(normalized))
    if (!entry) return
    this.bumpGeneration(entry)
    entry.replaceEpoch++ // A history replacement in flight is older than this: it ends without committing.
    entry.inflight = null
    entry.optimistic.clear()
    // Keep the last known read-only marker until a fresh newest page replaces it.
    entry.snapshot = { ...createDefaultState(entry.snapshot.generation), readOnly: entry.snapshot.readOnly }
    entry.lastOrdinaryView = undefined
    entry.windowGeneration++
    entry.resetHistory = entry.ordinary
    clearSessionPrefetch(normalized.directory, [normalized.sessionID], this.runtimeKey)
    this.notify(entry)
  }

  invalidateDirectory(directory: string): void {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory) return
    const prefix = `${this.runtimeKey}\n${normalizedDirectory}\n`
    clearDirectorySessionPrefetch(normalizedDirectory, this.runtimeKey)
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.entries.delete(key)
      this.notify(entry)
    }
  }

  dispose(): void {
    this.disposed = true
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.notify(entry)
    }
    this.entries.clear()
    clearRuntimeSessionPrefetch(this.runtimeKey)
  }

  private normalizeTarget(target: SessionMessageTarget): SessionMessageTarget | null {
    const directory = normalizePath(target.directory)
    if (!directory || !target.sessionID) return null
    return { directory, sessionID: target.sessionID }
  }

  private keyFor(target: SessionMessageTarget): string {
    return `${this.runtimeKey}\n${target.directory}\n${target.sessionID}`
  }

  private getEntry(target: SessionMessageTarget): LoaderEntry {
    const key = this.keyFor(target)
    const existing = this.entries.get(key)
    if (existing) return existing
    const prefetched = getSessionPrefetch(target.directory, target.sessionID, this.runtimeKey)
    const entry: LoaderEntry = {
      target,
      snapshot: prefetched
        ? {
            ...createDefaultState(),
            status: "ready",
            resolved: true,
            limit: prefetched.limit,
            cursor: prefetched.cursor,
            complete: prefetched.complete,
            updatedAt: prefetched.at,
          }
        : createDefaultState(),
      listeners: new Set(),
      inflight: null,
      reportId: newOperationId(),
      openUnanswered: false,
      loadedOnce: false,
      queuedRefresh: null,
      positionOf: new Map(),
      windowLoads: new Map(),
      rangeReads: false,
      windowGeneration: 0,
      queuedRefreshLimit: 0,
      optimistic: new Map(),
      ordinary: false,
      resetHistory: false,
      commits: 0,
      demand: 0,
      replaceEpoch: 0,
      ordinaryRefresh: null,
      ordinaryDemand: 0,
    }
    this.entries.set(key, entry)
    return entry
  }

  private patchEntry(entry: LoaderEntry, patch: Partial<SessionMessageLoadState>): void {
    entry.snapshot = { ...entry.snapshot, ...patch }
    if (typeof patch.ordinaryView === "string") entry.lastOrdinaryView = patch.ordinaryView
    this.notify(entry)
  }

  /** keepWindows: a same-epoch tail refresh; window reads in flight stay valid (openchamber#363 r13). */
  private bumpGeneration(entry: LoaderEntry, keepWindows = false): number {
    if (!keepWindows) entry.windowGeneration++
    const generation = entry.snapshot.generation + 1
    entry.snapshot = { ...entry.snapshot, generation }
    return generation
  }

  private notify(entry: LoaderEntry): void {
    for (const listener of entry.listeners) listener()
  }

  private startLoad(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    kind: SessionMessageLoadKind,
    run: (isCurrent: () => boolean, performance: LoadPerformanceDetails) => Promise<void>,
  ): Promise<void> {
    entry.demand++
    const generation = entry.snapshot.generation
    const sdkEpoch = this.sdkEpoch
    const runtimeKey = this.runtimeKey, operationId = entry.reportId // Its open and server, at its start (#536).
    const opening = !entry.loadedOnce // A loaded session's failed refresh is not a failed open.
    const finishPerformanceEvent = startSessionLoadPerformanceEvent({
      operation: kind === "prefetch" ? "session-prefetch" : `session-messages.${kind}`,
      caller: kind,
    })
    const isCurrent = () => (
      !this.disposed
      && this.sdkEpoch === sdkEpoch
      && entry.snapshot.generation === generation
      && this.childStores.getChild(target.directory) === store
    )
    const performance = { retryCount: 0, recordCount: 0 }
    const loading: Partial<SessionMessageLoadState> = { status: "loading", loadingKind: kind, error: null }
    if (kind !== "older" && kind !== "refresh") loading.ordinaryView = undefined
    this.patchEntry(entry, loading)
    let loadPromise: Promise<void>
    try {
      loadPromise = run(isCurrent, performance)
    } catch (error) {
      loadPromise = Promise.reject(error)
    }
    const promise = loadPromise
      .then(() => {
        if (isCurrent()) { entry.openUnanswered = false; entry.loadedOnce = true; entry.reportId = newOperationId() }
        finishPerformanceEvent(isCurrent() ? "complete" : "stale", performance)
      })
      .catch((cause: unknown) => {
        const error = cause
        if (!isCurrent()) {
          finishPerformanceEvent("stale", performance)
          return
        }
        finishPerformanceEvent("error", performance)
        entry.openUnanswered = opening && error instanceof Error && unanswered(error)
        if (entry.ordinary) this.invalidateOrdinaryView(target, true)
        const failure = error instanceof Error ? error : new Error(formatSdkError(error))
        this.patchEntry(entry, { status: "error", loadingKind: null, error: failure })
        // The page now shows "Session could not be loaded": the fleet sees it too (smarty-code#536), with the error's name
        // and HTTP status (smarty-code#1058). Only an obsolete read is silent (the !isCurrent() return above): a current
        // abort (a relay body cut by the read limit, #451 r2) or a superseded read with no successor (r1) is reported.
        const report = failureReport(failure)
        if (failure instanceof SupersededReadError) report.message += " (superseded-exhausted)"
        // A read that did not answer in time (a frozen or slow Pi) is its own diagnostic: session-messages.<kind>.timeout.
        const timedOut = unanswered(failure) // The client read limit, or the gateway's smarty.pi-timed-out.
        reportClientError({ kind: `session-messages.${kind}${timedOut ? ".timeout" : ""}`, sessionID: target.sessionID, runtimeKey, operationId,
          ...report }) // Never the server's words.
      })
      .finally(() => {
        if (entry.inflight === promise) entry.inflight = null
      })
    entry.inflight = promise
    // A load that ends claiming the whole history while the store holds a reply without its prompt (streamed while the
    // read was out) contradicts itself: the timeline would hide that reply (#126 item 4). Reload it from the start, once
    // for each missing prompt (one not tried before), while this load's page is still current.
    void promise.then(() => {
      if (!isCurrent() || entry.inflight || !entry.snapshot.resolved || !entry.snapshot.complete) return
      const missing = missingPrompts(store.getState(), target.sessionID)
      const tried = entry.repairedPrompts ??= new Set()
      if (![...missing].some((id) => !tried.has(id))) return
      for (const id of missing) tried.add(id)
      void this.ensure(target, { force: true, reason: "navigation" }).catch(() => undefined)
    })
    return promise
  }

  private async loadInitial(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    isCurrent: () => boolean,
    performance?: LoadPerformanceDetails,
  ): Promise<void> {
    const storeMessageCount = store.getState().message[target.sessionID]?.length ?? 0
    const firstLimit = entry.ordinary ? getInitialPageSize()
      : Math.max(entry.snapshot.limit, storeMessageCount, getInitialPageSize())
    const firstPage = await this.fetchOpenPage(target, firstLimit, isCurrent, performance)
    if (!isCurrent()) return
    const deferFirstCommit = !firstPage.complete && !hasUserMessage(firstPage.session)
    let committed = deferFirstCommit
      ? null
      : this.commitPage(target, entry, store, firstPage, "merge", isCurrent)
    let acceptedPage = firstPage

    if (deferFirstCommit) {
      for (const limit of getInitialExpansionLimits()) {
        if (limit <= firstLimit || !isCurrent()) continue
        const expandedPage = await this.fetchOpenPage(target, limit, isCurrent, performance)
        if (!isCurrent()) return
        acceptedPage = expandedPage
        const boundaryFound = hasUserMessage(expandedPage.session)
        const isLast = limit === getInitialExpansionLimits()[getInitialExpansionLimits().length - 1]
        if (expandedPage.complete || boundaryFound || isLast) {
          committed = this.commitPage(target, entry, store, expandedPage, "merge", isCurrent)
        }
        if (expandedPage.complete || boundaryFound) break
      }
    }

    if (deferFirstCommit && !committed && isCurrent()) {
      committed = this.commitPage(target, entry, store, acceptedPage, "merge", isCurrent)
    }
    if (!committed || !isCurrent()) return
    this.patchEntry(entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      limit: committed.messages.length,
      cursor: acceptedPage.cursor,
      complete: acceptedPage.complete,
      updatedAt: Date.now(),
    })
    this.persistCoverage(target, entry.snapshot)
  }

  /**
   * An open's page, read again while its ordinary view was read across a stream disconnect (at most twice). Such a view is
   * never accepted, and a read replays nothing: the phone's stream reconnecting during its first read showed "Session
   * could not be loaded" for 3-6 s, then the page recovered by itself (smarty-code#963).
   */
  private async fetchOpenPage(target: SessionMessageTarget, limit: number, isCurrent: () => boolean,
    performance?: LoadPerformanceDetails): Promise<FetchedPage> {
    for (let attempt = 0; ; attempt++) {
      const page = await this.fetchPage(target, limit, undefined, "initial-page", performance)
      if (!page.ordinaryView || page.viewEpoch === this.ordinaryEpoch || attempt >= 2 || !isCurrent()) return page
    }
  }

  private async fetchPage(
    target: SessionMessageTarget,
    limit: number,
    before?: string,
    caller: "initial-page" | "older" | "refresh" = "initial-page",
    performance?: LoadPerformanceDetails,
    cancelled?: () => boolean,
    at?: number,
    epoch?: string,
  ): Promise<FetchedPage> {
    const viewEpoch = this.ordinaryEpoch
    const eventsAtRead = sessionMessageEventCount(target.sessionID)
    const finishPagePerformance = startSessionLoadPerformanceEvent({
      operation: "session-messages.page",
      caller,
      requestLimit: limit,
      cursorPresent: before !== undefined,
    })
    let attempts = 0
    let recordCount = 0
    // An open: any read of a session that has not loaded on this page yet. A loaded session's reads (tail refresh,
    // older pages, a reload after a disconnect) keep their tries.
    const opening = !this.entries.get(this.keyFor(target))?.loadedOnce
    try {
      // An open whose read timed out is not tried again: a Pi that did not answer in the read's time (frozen, or its session
      // too slow to load) will not answer sooner, and three tries kept the page on its loading skeleton for over a
      // minute with nothing said (smarty-code#536, #562). It fails at once; the page shows why, with Try again.
      const result = await retry(async () => {
        if (cancelled?.()) throw new SupersededReadError("Session history read cancelled") // Not transient: no retry, no request.
        attempts += 1
        const response = await this.sdk.session.messages({
          sessionID: target.sessionID,
          directory: target.directory,
          limit,
          before,
          // smarty-code#583: a window by position (the gateway's range read); the SDK passes `$query_` keys through.
          // A newest page asks from the end (`at=-n`): the gateway then tells its position and the session's size. An
          // older gateway ignores `at` and serves the same newest page.
          ...(at !== undefined ? { $query_at: at } : before === undefined && limit <= 500 ? { $query_at: -limit } : {}),
          // A window names the index epoch its positions came from: the gateway answers 409 once it has changed.
          ...(at !== undefined && epoch !== undefined ? { $query_epoch: epoch } : {}),
        } as Parameters<OpencodeClient["session"]["messages"]>[0])
        assertSdkSuccess(response, "session.messages")
        const data = response.data
        if (!Array.isArray(data)) {
          const error: Error & { status?: number } = new Error("session.messages returned no data")
          error.status = 503
          throw error
        }
        return { data, response: response.response }
      }, { retryIf: error => isTransientError(error) && !(opening && error instanceof Error && unanswered(error)) })
      const records = result.data.filter((record: { info?: { id?: string } }) => Boolean(record?.info?.id))
      recordCount = records.length
      if (performance) performance.recordCount += recordCount
      const session = sortMessagesChronologically(
        records.map((record: { info: Message }) => stripMessageDiffSnapshots(record.info)),
      )
      const partsByMessageID = new Map<string, Part[]>()
      for (const record of records) {
        partsByMessageID.set(record.info.id, filterIdentifiedParts(record.parts ?? []))
      }
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      const ordinaryView = before === undefined
        ? result.response?.headers?.get?.("x-smarty-ordinary-view") ?? undefined : undefined
      if (ordinaryView !== undefined && !/^ov2_[a-f0-9]{64}$/.test(ordinaryView)) {
        throw new Error("Invalid ordinary history view")
      }
      finishPagePerformance("complete", { retryCount: Math.max(0, attempts - 1), recordCount })
      const readOnly = result.response?.headers?.get?.("x-smarty-read-only") === "1"
      const journalAt = before === undefined ? result.response?.headers?.get?.("x-smarty-journal-at") ?? undefined : undefined
      const position = readPositionHeaders(result.response?.headers)
      // A range read carries no cursor: with positions its page is complete when it starts at position 0 (smarty-code#583).
      // Without positions the cursor contract holds: complete when there is no cursor. That is a cursor-only gateway, or
      // a position gateway whose index still builds (it then sends x-next-cursor while older records remain). A newest
      // page that exactly fills its limit with no cursor is the whole history (pin 46 review 5897200984).
      const rangeRead = at !== undefined || position.at !== undefined
      const complete = position.at !== undefined ? position.at === 0 : !cursor
      return { rangeRead, session, partsByMessageID, cursor, complete, ordinaryView, readOnly, viewEpoch, journalAt, eventsAtRead, ...position }
    } catch (error) {
      finishPagePerformance("error", { retryCount: Math.max(0, attempts - 1), recordCount })
      throw error
    } finally {
      if (performance) performance.retryCount += Math.max(0, attempts - 1)
    }
  }

  private commitPage(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    page: FetchedPage,
    mode: "merge" | "prepend",
    isCurrent: () => boolean,
  ): { messages: Message[] } | null {
    if (!isCurrent()) return null
    // smarty-code#583: a page from another index epoch than the shown one: a window is not merged into the old records;
    // the loader starts over from a newest page, which replaces them.
    const knownEpoch = entry.snapshot.positions?.epoch
    if (page.total !== undefined && knownEpoch !== undefined && page.indexEpoch !== knownEpoch && entry.snapshot.positions!.ranges.length > 0) {
      if (mode === "prepend") {
        this.epochChanged(target, entry, page.total, page.indexEpoch)
        return null
      }
      entry.resetHistory = true
      entry.positionOf.clear()
    }
    if (page.ordinaryView && page.viewEpoch !== this.ordinaryEpoch) {
      throw new SupersededReadError("Ordinary history view was disconnected before materialization")
    }
    // A session shown live whose Pi then ended is read from its journal: read-only, with no view. It leaves ordinary mode
    // here, not "could not be loaded" (smarty-code#963 residual, 3.54). A live page without a view is still refused.
    if (mode !== "prepend" && page.readOnly && !page.ordinaryView) entry.ordinary = false
    entry.ordinary ||= page.ordinaryView !== undefined
    if (mode !== "prepend" && entry.ordinary && !page.ordinaryView) {
      throw new Error("Ordinary history response has no accepted view")
    }
    const merged = mergeOptimisticPage({
      session: page.session,
      part: [...page.partsByMessageID].map(([id, part]) => ({ id, part })),
      cursor: page.cursor,
      complete: page.complete,
    }, [...entry.optimistic.values()])
    for (const messageID of merged.confirmed) entry.optimistic.delete(messageID)
    const mergedPartsByMessageID = new Map(merged.part.map((candidate) => [candidate.id, candidate.part] as const))
    const reset = mode !== "prepend" && entry.resetHistory
    // A quiet ordinary newest page drops shown rows the gateway removed while this page missed events (#669, #675).
    const pruned = mode === "merge" && !reset && page.ordinaryView && page.eventsAtRead === sessionMessageEventCount(target.sessionID)
      ? withoutStaleOrdinaryRows(store.getState(), target.sessionID, page.session, page.complete,
        (id) => entry.optimistic.has(id)) : null
    const current = pruned ?? store.getState()
    const shownByID = new Map((current.message[target.sessionID] ?? []).map((message) => [message.id, message] as const))
    const part = reset ? { ...current.part } : current.part
    if (reset) {
      for (const message of current.message[target.sessionID] ?? []) {
        if (!entry.optimistic.has(message.id)) delete part[message.id]
      }
    }
    const materialized = materializeSessionSnapshots(
      reset ? { ...current, message: { ...current.message, [target.sessionID]: [] }, part } : current,
      target.sessionID,
      merged.session.map((info) => ({
        // A reset replaces the shown bucket, so no merge sees these records: keep a record shown as saved saved here.
        // An optimistic shadow never replaces the server's record already shown.
        info: !shownByID.has(info.id) ? info
          : optimisticMessageRecords.has(info) && !optimisticMessageRecords.has(shownByID.get(info.id)!) ? shownByID.get(info.id)!
            : keepSavedState(shownByID.get(info.id)!, info),
        parts: page.partsByMessageID.get(info.id)
          ?? mergedPartsByMessageID.get(info.id)
          ?? [],
      })),
      { skipPartTypes: SKIP_PARTS, mode },
    )
    if (!isCurrent()) return null
    // A read that replaced the shown history reflects exactly its journal state: older events are dropped (#278 r11).
    const journalReads = reset ? marked(current.journalReads, target.sessionID, page.journalAt) : undefined
    if (reset || pruned || materialized.messagesChanged || materialized.partsChanged) {
      const update: Partial<DirectoryStore> = journalReads ? { journalReads } : {}
      if (reset || pruned || materialized.messagesChanged) update.message = materialized.message
      if (reset || pruned || materialized.partsChanged) update.part = materialized.part
      store.setState(update)
    }
    entry.rangeReads ||= page.rangeRead === true
    entry.commits++ // Even a page that changed nothing (an accepted view, new coverage) makes a reset read older.
    if (!isCurrent()) return null
    if (mode !== "prepend") {
      entry.ordinary ||= page.ordinaryView !== undefined
      entry.resetHistory = false
      this.patchEntry(entry, { ordinaryView: page.ordinaryView, readOnly: page.readOnly })
    }
    this.notePositions(entry, page, reset)
    return { messages: materialized.messages }
  }

  /** smarty-code#583: records which positions a committed page covered; a new index epoch (or a reset) starts over. */
  private notePositions(entry: LoaderEntry, page: FetchedPage, reset: boolean): void {
    if (page.total === undefined || page.at === undefined) return
    const previous = entry.snapshot.positions
    const fresh = reset || !previous || previous.epoch !== page.indexEpoch
    if (fresh) entry.positionOf.clear()
    const ranges = addRange(fresh ? [] : previous.ranges, { start: page.at, end: page.at + page.session.length })
    for (const [index, message] of page.session.entries()) entry.positionOf.set(message.id, page.at + index)
    // Complete means every position up to the loaded end is loaded: one range from 0. Reaching position 0 with holes
    // after it is not (openchamber#363 review: an export after Beginning exported only the loaded windows).
    this.patchEntry(entry, { positions: { total: page.total, ranges, epoch: page.indexEpoch }, complete: ranges.length === 1 && ranges[0]!.start === 0 })
  }

  /**
   * smarty-code#583: the gateway's `session.index` event: the session's record count (and index epoch) changed. The list
   * grows without a read; a new epoch drops the recorded ranges. A session whose newest page came without positions (a
   * first open while the gateway built its index) reads its newest page again to learn them.
   */
  noteIndex(target: SessionMessageTarget, total: number, epoch: string | undefined): void {
    const normalized = this.normalizeTarget(target)
    const entry = normalized ? this.entries.get(this.keyFor(normalized)) : undefined
    if (!normalized || !entry || this.disposed || !Number.isInteger(total) || total < 0) return
    const previous = entry.snapshot.positions
    if (!previous) {
      if (entry.snapshot.resolved) void this.refreshTail(normalized, Math.min(500, Math.max(1, entry.snapshot.limit))).catch(() => undefined)
      return
    }
    if (previous.epoch !== epoch) return this.epochChanged(normalized, entry, total, epoch)
    this.patchEntry(entry, { positions: { total, ranges: previous.ranges, epoch } })
  }

  /** The session's pages came from range reads (the newest page asks at=-n): they carry no cursor (smarty-code#583). */
  private servesPositions(target: SessionMessageTarget): boolean {
    return this.entries.get(this.keyFor(target))?.rangeReads === true
  }

  /**
   * smarty-code#583 (joint contract section 3): the session's index epoch changed (a branch rewrite, a compaction): the
   * known positions and the shown records may no longer match. Reads in flight are fenced (a late old-epoch answer commits
   * nothing), the next newest page replaces the shown history, and the gap rows then read the windows in view again.
   */
  private epochChanged(target: SessionMessageTarget, entry: LoaderEntry, total: number, epoch: string | undefined): void {
    this.bumpGeneration(entry)
    entry.inflight = null
    entry.windowLoads.clear()
    entry.positionOf.clear()
    entry.resetHistory = true
    this.patchEntry(entry, { positions: { total, ranges: [], epoch }, complete: false })
    void this.refreshTail(target, Math.min(500, Math.max(HISTORY_MESSAGE_PAGE_SIZE, entry.snapshot.limit))).catch(() => undefined)
  }

  /** The loaded message's position in the whole session, when the gateway serves positions (smarty-code#583). */
  positionOf(target: SessionMessageTarget, messageID: string): number | undefined {
    const normalized = this.normalizeTarget(target)
    return normalized ? this.entries.get(this.keyFor(normalized))?.positionOf.get(messageID) : undefined
  }

  /**
   * smarty-code#583: loads the window of `limit` records from position `at` (a gap the reader reached, a jump, a
   * scrollbar drag). It merges into the shown history like any page; positions keep it in place in the whole session.
   */
  loadAt(target: SessionMessageTarget, at: number, limit: number): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    const key = `${at}:${limit}`
    const pending = entry.windowLoads.get(key)
    if (pending) return pending
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    // Fenced by the window generation: an epoch change, a reset or a reopen cancels the read; an ordinary same-epoch tail
    // refresh (session.idle) does not (openchamber#363 r13: the reader was left on the placeholder).
    const generation = entry.windowGeneration, sdkEpoch = this.sdkEpoch
    const isCurrent = () => !this.disposed && this.sdkEpoch === sdkEpoch && entry.windowGeneration === generation
      && this.childStores.getChild(normalized.directory) === store
    // Windows read beside the loader's own loads: they only add records at known positions, and a stale one (a new
    // open, another view) commits nothing.
    const load = this.fetchPage(normalized, limit, undefined, "older", undefined, () => !isCurrent(), at, entry.snapshot.positions?.epoch)
      .then((page) => {
        if (!isCurrent()) return
        this.commitPage(normalized, entry, store, page, "prepend", isCurrent)
      }, (error: unknown) => {
        // 409: the positions this window was asked by belong to an older index epoch: start over (contract section 3).
        if ((error as { status?: number })?.status === 409 && isCurrent()) {
          this.epochChanged(normalized, entry, entry.snapshot.positions?.total ?? 0, undefined)
          return
        }
        throw error
      })
      .finally(() => { entry.windowLoads.delete(key) })
    entry.windowLoads.set(key, load)
    return load
  }

  private persistCoverage(target: SessionMessageTarget, state: SessionMessageLoadState): void {
    // A read-only view must be re-fetched (not rebuilt from coverage) so its marker is never lost.
    if (this.entries.get(this.keyFor(target))?.ordinary || state.readOnly) {
      clearSessionPrefetch(target.directory, [target.sessionID], this.runtimeKey)
      return
    }
    setSessionPrefetch({
      directory: target.directory,
      sessionID: target.sessionID,
      limit: state.limit,
      cursor: state.cursor,
      complete: state.complete,
      at: state.updatedAt,
      runtimeKey: this.runtimeKey,
    })
  }
}

/** The store's replacing-read marks with this session's set to `at`, or removed when the read had none (#278 r11). */
function marked(marks: Record<string, string> | undefined, sessionID: string, at: string | undefined): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(marks ?? {}).filter(([id]) => id !== sessionID))
  return at === undefined ? rest : { ...rest, [sessionID]: at }
}

/** Whether a newest page (not an older one) is the first ordinary page of a session this loader showed only as View only
 * (read-only, never with an ordinary view): a session already served as ordinary is not leaving anything. */
function leavesViewOnly(entry: LoaderEntry, page: FetchedPage, mode: "merge" | "prepend"): boolean {
  return mode !== "prepend" && !entry.ordinary && entry.snapshot.readOnly === true
    && (!page.readOnly || page.ordinaryView !== undefined)
}

type DirectoryStoreSetter = (
  partial: Partial<DirectoryStore> | ((state: DirectoryStore) => Partial<DirectoryStore> | DirectoryStore),
) => void

/** The prompts (parent messages) that assistant replies in the store point to but the store does not have. */
function missingPrompts(state: DirectoryStore, sessionID: string): Set<string> {
  const messages = state.message[sessionID] ?? []
  const ids = new Set(messages.map((message) => message.id))
  const missing = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant" && message.parentID && !ids.has(message.parentID)) missing.add(message.parentID)
  }
  return missing
}
const hasReplyWithoutPrompt = (state: DirectoryStore, sessionID: string): boolean => missingPrompts(state, sessionID).size > 0

let imperativeLoader: SessionMessageLoader | null = null

export function setImperativeSessionMessageLoader(loader: SessionMessageLoader | null): void {
  imperativeLoader = loader
}

export function getImperativeSessionMessageLoader(): SessionMessageLoader | null {
  return imperativeLoader
}

/** smarty-code#583: the gateway's position headers for a page, when it serves them (the range read contract). */
function readPositionHeaders(headers: Headers | undefined): { at?: number; total?: number; indexEpoch?: string } {
  const number = (name: string) => {
    const value = headers?.get?.(name)
    const parsed = value === null || value === undefined ? NaN : Number(value)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  const total = number("x-smarty-total"), at = number("x-smarty-at")
  const indexEpoch = headers?.get?.("x-smarty-index-epoch") ?? undefined
  return total === undefined || at === undefined ? {} : { at, total, ...(indexEpoch ? { indexEpoch } : {}) }
}
