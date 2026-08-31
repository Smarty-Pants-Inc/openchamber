/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import { z } from "zod"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { opencodeClient } from "@/lib/opencode/client"
import { mergeSessionDirectoryMetadata, resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { registerSessionDirectory } from "./sync-refs"
import { recordSendFailure } from "./send-failure-log"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { materializeSessionSnapshots } from "./materialization"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withAgentBackendMetadata,
  withoutReviewSessionLink,
} from "@/lib/sessionReviewMetadata"
import type { SessionMetadataRecord } from "@/lib/sessionReviewMetadata"
import { bindRuntimeTransport, runtimeFetch } from "@/lib/runtime-fetch"
import { confirmRetainedSessionDeletion, RetainedSessionError } from "@/lib/retainedSessionError"
import { createPiSessionWithPendingDialogs } from "./pi-pending-create"
import { withContextObligatoryMessage, type ContextObligatoryMessage } from "@/lib/contextObligatoryMessages"
import { getBtwOriginalSessionID, getBtwSessionID, isBtwSession, withoutBtwSessionLink } from "@/lib/sessionBtwMetadata"
import { withLinkedIssue, type LinkedIssue } from "@/lib/linkedIssues"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { getRuntimeKey, getRuntimeTransportEpoch } from "@/lib/runtime-switch"
import { isAmbiguousTransportFailure } from "@/lib/relay/transport-error"
import { getStaleRunningToolMessageID } from "./materialization"
import { normalizePath } from "@/lib/pathNormalization"
import { mergeMessages } from "./optimistic"
import { messagesBefore, messagesFrom } from "./message-ordering"
import { deleteChatDirectory } from "@/lib/chatDirectories"

const MESSAGE_REFETCH_LIMIT = 100
const SEND_CONFIRMATION_REFETCH_LIMIT = 30
// A relay-tunnel send fails when the tunnel drops, and the confirming refetch
// then has to travel over that same tunnel to answer "did my message land?".
// Two attempts 150ms apart always answered "no" on a remote connection, so an
// accepted prompt looked like a failed one and got re-sent — two AI responses
// for one user message. Wait for the connection to actually come back (an
// authoritative signal, not a blind sleep), then retry with backoff. A healthy
// connection skips the wait and answers on the first attempt.
const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3
const SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS = 250
const SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3000
const SEND_CONFIRMATION_RECONNECT_POLL_MS = 100
const MESSAGE_REFETCH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const UNREVERT_REFETCH_ATTEMPTS = 3
const UNREVERT_REFETCH_RETRY_MS = 150

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
// Optional ref into the sync layer's session-tail materialization queue. Used
// to reconcile a trailing running tool part after a blocking request is
// confirmed stale server-side (see recoverStaleBlockingRequest).
let _enqueueSessionMaterialization: ((directory: string, sessionID: string, messageID: string) => void) | null = null
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }
type OptimisticConfirmInput = OptimisticRemoveInput

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null
let _optimisticConfirm: ((input: OptimisticConfirmInput) => void) | null = null

function sessionMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionId: string,
  deleted: boolean,
) {
  const revision = (state.sessionRevision ?? 0) + 1
  const sessionEventRevision = { ...(state.sessionEventRevision ?? {}) }
  const sessionDeletedRevision = { ...(state.sessionDeletedRevision ?? {}) }
  if (deleted) {
    sessionDeletedRevision[sessionId] = revision
    delete sessionEventRevision[sessionId]
  } else {
    sessionEventRevision[sessionId] = revision
    delete sessionDeletedRevision[sessionId]
  }
  return {
    sessionListSource: "live" as const,
    sessionRevision: revision,
    sessionEventRevision,
    sessionDeletedRevision,
  }
}

function invalidateSessionLoads(sessionId: string, directories: Iterable<string | null | undefined>): void {
  const loader = getImperativeSessionMessageLoader()
  if (!loader) return
  for (const directory of new Set(directories)) {
    if (directory) loader.invalidateSession({ directory, sessionID: sessionId })
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: { status?: number }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message

    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object") {
      const dataMessage = (data as { message?: unknown }).message
      if (typeof dataMessage === "string" && dataMessage.length > 0) return dataMessage
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (!result.error) return result.data
  const status = result.response?.status
  const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`) as Error & { status?: number }
  if (status !== undefined) error.status = status
  throw error
}

function assertSdkData<T>(result: SdkResult<T>, operation: string): T {
  const data = assertSdkSuccess(result, operation)
  if (data === undefined || data === null) {
    throw new Error(`${operation} failed: empty response`)
  }
  return data
}

export function setActionRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  getDirectory: () => string,
  enqueueSessionMaterialization?: (directory: string, sessionID: string, messageID: string) => void,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory
  _enqueueSessionMaterialization = enqueueSessionMaterialization ?? null
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
  confirm?: (input: OptimisticConfirmInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
  _optimisticConfirm = confirm ?? null
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dirStoreForDirectory(directory: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory)
}

function dirStoreForSession(sessionId: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

/**
 * Provider/model of the session's last assistant message — the authoritative
 * "session provider" for utility calls (notes distillation etc.), independent
 * of what the composer picker currently points at.
 */
export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const { store } = dirStoreForSession(sessionId)
    const messages = store.getState().message[sessionId]
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i] as { role?: string; providerID?: string; modelID?: string }
      if (info?.role === "assistant" && typeof info.providerID === "string" && info.providerID
        && typeof info.modelID === "string" && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  } catch {
    return null
  }
}

function updateLiveSession(session: Session, directory?: string): boolean {
  const stores = _childStores
  if (!stores) return false

  const candidates = directory
    ? [[directory, stores.getChild(directory)] as const]
    : stores.children

  for (const [, store] of candidates) {
    if (!store) continue
    const current = store.getState().session
    const index = current.findIndex((item) => item.id === session.id)
    if (index === -1) continue

    const next = [...current]
    next[index] = mergeSessionDirectoryMetadata(session, current[index])
    store.setState({ session: next })
    return true
  }

  return false
}

function mirrorSessionIntoLiveStores(session: Session, directory?: string): void {
  if (directory && updateLiveSession(session, directory)) {
    return
  }
  updateLiveSession(session)
}

function moveRecordEntries<T>(
  source: Record<string, T>,
  destination: Record<string, T>,
  keys: Iterable<string>,
): { source: Record<string, T>; destination: Record<string, T> } {
  let nextSource = source
  let nextDestination = destination

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    if (nextSource === source) nextSource = { ...source }
    if (nextDestination === destination) nextDestination = { ...destination }
    nextDestination[key] = source[key]
    delete nextSource[key]
  }

  return { source: nextSource, destination: nextDestination }
}

function reconcileSessionMove(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
): Session {
  const stores = _childStores
  const sourceStore = stores?.getChild(sourceDirectory)
  const destinationStore = stores?.ensureChild(destinationDirectory, { bootstrap: false })
  const sourceState = sourceStore?.getState()
  const destinationState = destinationStore?.getState()
  const liveSession = sourceState?.session.find((candidate) => candidate.id === session.id) ?? session
  const movedSession = { ...liveSession, directory: destinationDirectory } as Session

  if (!destinationStore || !destinationState || sourceStore === destinationStore) {
    return movedSession
  }

  const destinationSessionIndex = destinationState.session.findIndex((candidate) => candidate.id === session.id)
  const destinationSessions = [...destinationState.session]
  if (destinationSessionIndex === -1) destinationSessions.push(movedSession)
  else destinationSessions[destinationSessionIndex] = movedSession

  if (!sourceStore || !sourceState) {
    destinationStore.setState({
      session: destinationSessions,
      sessionTotal: destinationSessionIndex === -1
        ? destinationState.sessionTotal + 1
        : destinationState.sessionTotal,
    })
    return movedSession
  }

  const sourceContainsSession = sourceState.session.some((candidate) => candidate.id === session.id)
  const status = moveRecordEntries(sourceState.session_status, destinationState.session_status, [session.id])
  const diffs = moveRecordEntries(sourceState.session_diff, destinationState.session_diff, [session.id])
  const todos = moveRecordEntries(sourceState.todo, destinationState.todo, [session.id])
  const permissions = moveRecordEntries(sourceState.permission, destinationState.permission, [session.id])
  const questions = moveRecordEntries(sourceState.question, destinationState.question, [session.id])
  const messages = moveRecordEntries(sourceState.message, destinationState.message, [session.id])
  const messageIds = sourceState.message[session.id]?.map((message) => message.id) ?? []
  const parts = moveRecordEntries(sourceState.part, destinationState.part, messageIds)

  sourceStore.setState({
    session: sourceState.session.filter((candidate) => candidate.id !== session.id),
    sessionTotal: sourceContainsSession ? Math.max(0, sourceState.sessionTotal - 1) : sourceState.sessionTotal,
    session_status: status.source,
    session_diff: diffs.source,
    todo: todos.source,
    permission: permissions.source,
    question: questions.source,
    message: messages.source,
    part: parts.source,
    ...sessionMutationPatch(sourceState, session.id, true),
  })
  destinationStore.setState({
    session: destinationSessions,
    sessionTotal: destinationSessionIndex === -1
      ? destinationState.sessionTotal + 1
      : destinationState.sessionTotal,
    session_status: status.destination,
    session_diff: diffs.destination,
    todo: todos.destination,
    permission: permissions.destination,
    question: questions.destination,
    message: messages.destination,
    part: parts.destination,
    ...sessionMutationPatch(destinationState, session.id, false),
  })

  return movedSession
}

export async function moveSessionToDirectory(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
  moveChanges = true,
): Promise<void> {
  const result = await opencodeClient.getSdkClient().experimental.controlPlane.moveSession({
    sessionID: session.id,
    destination: { directory: destinationDirectory },
    moveChanges,
  })
  assertSdkSuccess(result, "Move session")

  invalidateSessionLoads(session.id, [sourceDirectory, destinationDirectory])

  const moved = reconcileSessionMove(session, sourceDirectory, destinationDirectory)

  registerSessionDirectory(session.id, destinationDirectory)
  useGlobalSessionsStore.getState().upsertSession(moved)
  useSessionUIStore.getState().setSessionDirectory(session.id, destinationDirectory)
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const direct = (error as { status?: unknown }).status
  if (typeof direct === "number") return direct
  const response = (error as { response?: { status?: unknown } }).response
  return typeof response?.status === "number" ? response.status : null
}

function isAmbiguousSendFailure(error: unknown): boolean {
  // Authoritative first: the transport that lost the request says whether it
  // had already been dispatched. The text matching below only covers direct
  // fetch/HTTP failures, whose wording we do not control either — relay tunnel
  // aborts ("stream aborted by host", "relay keepalive timeout", …) match none
  // of those patterns and used to be misread as definite failures.
  if (isAmbiguousTransportFailure(error)) return true

  const status = getErrorStatus(error)
  if (status === 503 || status === 504 || status === 408) return true
  if (error instanceof TypeError) return true
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : typeof error === "string"
      ? error.toLowerCase()
      : ""

  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("network error")
    || message.includes("gateway timeout")
    || message.includes("econnreset")
    || message.includes("socket hang up")
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

type SessionListSnapshot = {
  directory: string
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function getSessionDirectory(sessionId: string): string | undefined {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  return findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || (globalSession ? resolveGlobalSessionDirectory(globalSession) ?? undefined : undefined)
    || dir()
}

function findSessionDirectoryInChildStores(sessionId: string): string | null {
  const stores = _childStores
  if (!stores || !sessionId) return null

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function getSessionReplyClient(sessionId?: string): OpencodeClient {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  if (directory) {
    return opencodeClient.getScopedSdkClient(directory)
  }
  return sdk()
}

function restoreFilePartsToInput(fileParts: Array<Record<string, unknown>>): void {
  useInputStore.getState().clearAttachedFiles()
  for (const filePart of fileParts) {
    const url = typeof filePart.url === "string" ? filePart.url : ""
    const mime = typeof filePart.mime === "string" ? filePart.mime : "application/octet-stream"
    const filename = typeof filePart.filename === "string" ? filePart.filename : "attachment"
    if (url) {
      useInputStore.getState().addRestoredAttachment({ url, mimeType: mime, filename })
    }
  }
}

/**
 * Server-confirmed directory that owns a session, from the session record
 * (`directory`, then `project.worktree`). Mirrors the authoritative source in
 * session-directory-resolution: holding a session in a child store proves
 * containment, not ownership — a project's session list legitimately includes
 * the sessions of its worktrees so the sidebar can group them — so reading
 * ownership from the containing store reports the parent for a session that
 * lives in a worktree, and every fetch is then addressed to a directory that
 * does not own it.
 */
function resolveSessionOwnedDirectory(session: Session): string | null {
  const record = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  const raw = typeof record.directory === "string" && record.directory.trim().length > 0
    ? record.directory
    : typeof record.project?.worktree === "string" && record.project.worktree.trim().length > 0
      ? record.project.worktree
      : null
  return raw ? normalizePath(raw) : null
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.question
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string; sessionID?: string }> | undefined>) {
      const request = requests?.find((candidate) => candidate.id === requestId)
      if (!request) continue

      // Ownership beats containment. The request belongs to one specific
      // session, and the reply must reach the instance that actually tracks
      // it — the directory the session record's server-confirmed `directory`
      // names. The containing store's key only proves containment: a project
      // store holds its worktree sessions too, and a reply addressed to the
      // parent instance makes the server answer QuestionNotFoundError while
      // the question stays pending in the worktree instance, leaving the
      // session stuck on the running question tool. Fall back to the store
      // key only when the session record carries no directory.
      const requestSessionID = typeof request.sessionID === "string" && request.sessionID.length > 0
        ? request.sessionID
        : sessionId
      const sessionRecord = requestSessionID
        ? state.session.find((s) => s.id === requestSessionID)
        : undefined
      const ownedDirectory = sessionRecord ? resolveSessionOwnedDirectory(sessionRecord) : null
      if (ownedDirectory) return ownedDirectory
      return directory
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

export function isQuestionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Question(?:\.)?NotFoundError|Question request not found/i.test(message)
}

/**
 * Reconcile the trailing assistant tool part after a blocking request turned
 * out to be stale server-side (reply/reject answered with not-found). The
 * local request is removed (the server no longer tracks it), but the
 * question/permission tool part can remain `running` with the session busy —
 * the UI would stay on "asking question" with no recovery until the user
 * stops the run. Enqueue the sync layer's settled-running-tool tail
 * materialization so the part converges to the server's actual state.
 */
function recoverStaleBlockingRequest(sessionId: string): void {
  const stores = _childStores
  const enqueue = _enqueueSessionMaterialization
  if (!stores || !enqueue || !sessionId) return

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      !state.session.some((session) => session.id === sessionId)
      && !Object.prototype.hasOwnProperty.call(state.message, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      continue
    }
    const messageID = getStaleRunningToolMessageID(state, sessionId)
    if (messageID) {
      enqueue(directory, sessionId, messageID)
    }
    return
  }
}

function removeQuestionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().question ?? {}
    let nextQuestion: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextQuestion ??= { ...current }
      if (nextRequests.length > 0) {
        nextQuestion[candidateSessionId] = nextRequests
      } else {
        delete nextQuestion[candidateSessionId]
      }
      removed = true
    }

    if (nextQuestion) {
      store.setState({ question: nextQuestion })
    }
  }

  return removed
}

function isPermissionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Permission(?:\.)?NotFoundError|Permission request not found/i.test(message)
}

function removePermissionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().permission ?? {}
    let nextPermission: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextPermission ??= { ...current }
      if (nextRequests.length > 0) {
        nextPermission[candidateSessionId] = nextRequests
      } else {
        delete nextPermission[candidateSessionId]
      }
      removed = true
    }

    if (nextPermission) {
      store.setState({ permission: nextPermission })
    }
  }

  return removed
}

function getRequestReplyClient(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): OpencodeClient {
  const requestDirectory = resolveDirectoryForBlockingRequest(type, sessionId, requestId)
  if (requestDirectory) {
    return opencodeClient.getScopedSdkClient(requestDirectory)
  }
  return getSessionReplyClient(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
  providerID?: string,
  metadata?: SessionMetadataRecord,
  selectionTransition?: "submitted-draft",
): Promise<Session | null> {
  try {
    // Capture the effective directory used for session creation so we can fall
    // back to it when the server response omits the `directory` field.
    // Without this, setCurrentSession would fall through to a stale
    // opencodeClient.getDirectory() value and group the session under the
    // wrong project (closes #1637, #2270).
    const effectiveDirectory = directoryOverride ?? dir()
    const session = await opencodeClient.createSession({
      title,
      parentID: parentID ?? undefined,
      metadata,
      providerID,
    }, effectiveDirectory)

    const sessionDirectory = (session as { directory?: string | null }).directory ?? effectiveDirectory ?? null
    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
    }
    useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory, selectionTransition)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    if (error instanceof RetainedSessionError) throw error
    return null
  }
}

/**
 * True when a caller captured a runtime key before an asynchronous mutation and
 * that runtime is no longer the active one. Callers pass `undefined` when they
 * do not participate in runtime-scoped guarding, which keeps the previous
 * unguarded behavior.
 */
function isStaleRuntime(expectedRuntimeKey: string | undefined): boolean {
  return expectedRuntimeKey !== undefined && getRuntimeKey() !== expectedRuntimeKey
}

type SessionMutationGuard = () => void

const assertSessionMutationCurrent = (
  expectedRuntimeKey: string | undefined,
  assertCurrent: SessionMutationGuard | undefined,
): void => {
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  assertCurrent?.()
}

/**
 * Apply an OpenChamber metadata update through the server-owned compare-and-
 * swap endpoint. The UI only owns top-level `metadata.openchamber` leaves, so
 * unrelated metadata cannot be overwritten by a stale full-object update.
 */
const SESSION_METADATA_CAS_ATTEMPTS = 3

type SessionMetadataOperation = {
  type: "set" | "delete"
  path: ["openchamber", string]
  expected: { exists: boolean; value?: unknown }
  value?: unknown
}

const isMetadataObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const metadataValueEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => metadataValueEqual(value, right[index]))
  }
  if (!isMetadataObject(left) || !isMetadataObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && metadataValueEqual(left[key], right[key]))
}

const openChamberMetadata = (metadata: SessionMetadataRecord): Record<string, unknown> =>
  isMetadataObject(metadata.openchamber) ? metadata.openchamber : {}

const updatesOnlyOpenChamberMetadata = (
  current: SessionMetadataRecord,
  next: SessionMetadataRecord,
): boolean => {
  const currentOutside = { ...current }
  const nextOutside = { ...next }
  delete currentOutside.openchamber
  delete nextOutside.openchamber
  return metadataValueEqual(currentOutside, nextOutside)
}

const metadataOperations = (
  current: SessionMetadataRecord,
  next: SessionMetadataRecord,
): SessionMetadataOperation[] => {
  const currentNamespace = openChamberMetadata(current)
  const nextNamespace = openChamberMetadata(next)
  const keys = new Set([...Object.keys(currentNamespace), ...Object.keys(nextNamespace)])
  const operations: SessionMetadataOperation[] = []
  for (const key of keys) {
    const currentExists = Object.prototype.hasOwnProperty.call(currentNamespace, key)
    const nextExists = Object.prototype.hasOwnProperty.call(nextNamespace, key)
    if (currentExists === nextExists && (!currentExists || metadataValueEqual(currentNamespace[key], nextNamespace[key]))) {
      continue
    }
    const expected = currentExists
      ? { exists: true, value: currentNamespace[key] }
      : { exists: false }
    operations.push(nextExists
      ? { type: "set", path: ["openchamber", key], expected, value: nextNamespace[key] }
      : { type: "delete", path: ["openchamber", key], expected })
  }
  return operations
}

const commitMetadataSession = (updated: Session, targetDirectory: string | null | undefined): Session => {
  useGlobalSessionsStore.getState().upsertSession(updated)
  // SAFETY: OpenCode returns a directory field that the SDK Session type omits.
  const updatedWithDirectory = updated as Session & { directory?: string | null }
  const sessionDirectory = updatedWithDirectory.directory ?? targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  mirrorSessionIntoLiveStores(updated, sessionDirectory ?? undefined)
  return updated
}

type SessionMetadataReader = Pick<typeof opencodeClient, "getSession">
type SessionMetadataRequester = (
  input: string,
  init: { method: "PATCH"; headers: Record<string, string>; body: string },
) => Promise<Response>

type SessionMetadataPatchOptions = {
  client: SessionMetadataReader
  request: SessionMetadataRequester
  expectedRuntimeKey?: string
  assertCurrent?: SessionMutationGuard
  publish: boolean
}

const patchSessionMetadataWithTransport = async (
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  options: SessionMetadataPatchOptions,
): Promise<Session> => {
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  if (!targetDirectory) throw new Error("Session directory is required")
  const assertCurrent = (): void => {
    if (options.publish) {
      assertSessionMutationCurrent(options.expectedRuntimeKey, options.assertCurrent)
    }
  }
  let lastConflict: Error | null = null
  for (let attempt = 0; attempt < SESSION_METADATA_CAS_ATTEMPTS; attempt += 1) {
    assertCurrent()
    const current = await options.client.getSession(sessionId, targetDirectory)
    assertCurrent()
    const currentMetadata = getSessionMetadata(current)
    const nextMetadata = updater(currentMetadata)
    if (!updatesOnlyOpenChamberMetadata(currentMetadata, nextMetadata)) {
      throw new Error("Session metadata updates are limited to OpenChamber metadata")
    }
    const operations = metadataOperations(currentMetadata, nextMetadata)
    if (operations.length === 0) {
      assertCurrent()
      return options.publish ? commitMetadataSession(current, targetDirectory) : current
    }
    const response = await options.request(`/api/openchamber/sessions/${encodeURIComponent(sessionId)}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: targetDirectory, operations }),
    })
    assertCurrent()
    if (response.status === 409) {
      lastConflict = await sessionForkRequestError(response, "Session metadata changed before the update could be applied")
      continue
    }
    if (!response.ok) throw await sessionForkRequestError(response, "Failed to update session metadata")
    const body = await response.json().catch(() => null) as { session?: unknown } | null
    // Decoding is asynchronous. Recheck before inspecting this response so a
    // previous runtime can never reach the local commit path.
    assertCurrent()
    if (!isMetadataObject(body?.session) || typeof body.session.id !== "string" || body.session.id.length === 0) {
      throw new Error("Invalid session metadata response")
    }
    // Keep the authority check adjacent to the only local mutation.
    assertCurrent()
    return options.publish ? commitMetadataSession(body.session as Session, targetDirectory) : body.session as Session
  }
  throw lastConflict ?? new Error("Session metadata changed before the update could be applied")
}

export async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  expectedRuntimeKey = getRuntimeKey(),
  client: SessionMetadataReader = opencodeClient,
  assertCurrent?: SessionMutationGuard,
): Promise<Session> {
  return patchSessionMetadataWithTransport(sessionId, directory, updater, {
    client,
    request: runtimeFetch,
    expectedRuntimeKey,
    assertCurrent,
    publish: true,
  })
}

const forkErrorResponseSchema = z.object({
  error: z.string().trim().min(1),
})

const forkRetainedResponseSchema = z.object({
  error: z.string().trim().min(1),
  partial: z.literal(true),
  partialAction: z.literal("fork-retained"),
  sessionId: z.string().trim().min(1),
  directory: z.string().trim().min(1).optional(),
  recovery: z.object({
    fork: z.object({
      confirmed: z.literal(false),
      detail: z.string().trim().min(1),
    }),
  }),
})

const sessionForkRequestError = async (
  response: Response,
  fallback: string,
  runtimeKey?: string,
): Promise<Error> => {
  const body: unknown = await response.json().catch(() => null)
  const parsedError = forkErrorResponseSchema.safeParse(body)
  const message = parsedError.success ? parsedError.data.error : fallback
  const cause = Object.assign(new Error(message), { status: response.status })
  if (!runtimeKey) return cause
  const retained = forkRetainedResponseSchema.safeParse(body)
  if (!retained.success) return cause
  const outcome = retained.data.recovery.fork
  return new RetainedSessionError(`Forked session ${retained.data.sessionId} was retained: ${outcome.detail}`, {
    sessionID: retained.data.sessionId,
    directory: retained.data.directory ?? null,
    runtimeKey,
    cause,
    compensationError: new Error(outcome.detail),
    outcome,
  })
}

export type ForkedSession = Session & { directory: string }
type ForkAuthorizedRequest = {
  directory: string
  messageId?: string
  providerID?: string
}
const forkAuthorizedResponseSchema = z.object({
  session: z.object({ id: z.string().min(1) }).passthrough(),
  directory: z.string().min(1),
})

const confirmForkDeletion = (
  session: ForkedSession,
  runtimeKey: string,
  cause: Error,
  deleteSession: () => Promise<boolean>,
): Promise<void> => confirmRetainedSessionDeletion({
  sessionID: session.id,
  directory: session.directory,
  runtimeKey,
  cause,
  failureMessage: "Failed to confirm removal of the forked session",
  deleteSession,
})

export class BoundSessionOperationError extends Error {
  readonly status?: number

  constructor(operation: string, status?: number) {
    super(`${operation} failed`)
    this.name = "BoundSessionOperationError"
    this.status = status
  }
}

type BoundSdkResponse<T> = {
  data?: T
  response?: { status?: number }
}

const requireBoundSessionData = <T>(response: BoundSdkResponse<T>, operation: string): T => {
  if (response.data !== undefined && response.data !== null) return response.data
  throw new BoundSessionOperationError(operation, response.response?.status)
}
export type BoundSessionCreateInput = {
  parentID?: string
  title?: string
  metadata?: SessionMetadataRecord
  providerID?: string
}


export interface BoundSessionOperation {
  runtimeKey: string
  request: typeof runtimeFetch
  create: (input?: BoundSessionCreateInput, directory?: string | null) => Promise<Session>
  get: (sessionId: string, directory?: string | null) => Promise<Session>
  getMessages: (sessionId: string, limit?: number, directory?: string | null) => Promise<Array<{ info: Message; parts: Part[] }>>
  patchMetadata: (
    sessionId: string,
    directory: string | null | undefined,
    updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  ) => Promise<Session>
  fork: (
    sessionId: string,
    messageId?: string,
    providerID?: string,
    directory?: string | null,
  ) => Promise<ForkedSession>
  delete: (sessionId: string, directory?: string | null) => Promise<boolean>
  updateTitle: (sessionId: string, title: string, directory?: string | null) => Promise<Session>
  assertCurrent: () => void
  publish: (session: Session, directory?: string | null) => Session
  finalizeDeletion: (sessionId: string, directory?: string | null) => void
  release: () => void
}

export async function getSessionForkCapability(
  sessionId: string,
  directory: string | null | undefined,
  expectedRuntimeKey = getRuntimeKey(),
  assertCurrent?: SessionMutationGuard,
): Promise<boolean> {
  const assertMutationCurrent = () => assertSessionMutationCurrent(expectedRuntimeKey, assertCurrent)
  assertMutationCurrent()
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  if (!targetDirectory) throw new Error("Session directory is required")
  const response = await runtimeFetch(`/api/openchamber/sessions/${encodeURIComponent(sessionId)}/fork-capability`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: targetDirectory }),
  })
  assertMutationCurrent()
  if (!response.ok) throw await sessionForkRequestError(response, "Failed to check session fork capability")
  const body = await response.json().catch(() => null) as { supported?: unknown } | null
  if (typeof body?.supported !== "boolean") throw new Error("Invalid session fork capability response")
  return body.supported
}

/**
 * Preserves the legacy surface for callers that need a source snapshot after
 * authorization, while moving the authorization itself behind server authority.
 */
export async function authorizeSessionFork(
  sessionId: string,
  directory: string | null | undefined,
  expectedRuntimeKey = getRuntimeKey(),
  client: Pick<typeof opencodeClient, "getSession"> = opencodeClient,
  assertCurrent?: SessionMutationGuard,
): Promise<Session> {
  const assertMutationCurrent = () => assertSessionMutationCurrent(expectedRuntimeKey, assertCurrent)
  const supported = await getSessionForkCapability(sessionId, directory, expectedRuntimeKey, assertCurrent)
  if (!supported) throw new Error("Managed Pi/OMP sessions cannot be forked")
  assertMutationCurrent()
  const source = await client.getSession(sessionId, directory)
  assertMutationCurrent()
  return source
}

/**
 * Binds every remote request in a logical session operation to the transport
 * active at its start. Transport methods never write local state: callers use
 * `publish` or `finalizeDeletion` only after their final authority guard.
 */
export function bindSessionOperation(): BoundSessionOperation {
  const runtimeKey = getRuntimeKey()
  const transportEpoch = getRuntimeTransportEpoch()
  const activeSdkClient = opencodeClient.getSdkClient()
  const transport = bindRuntimeTransport()
  const client = createOpencodeClient({
    baseUrl: transport.apiBaseUrl,
    fetch: transport.fetch,
  })

  const assertCurrent = (): void => {
    if (getRuntimeKey() !== runtimeKey
      || getRuntimeTransportEpoch() !== transportEpoch
      || opencodeClient.getSdkClient() !== activeSdkClient) {
      throw new Error("runtime changed")
    }
  }

  const get = async (sessionId: string, directory?: string | null): Promise<Session> => {
    const response = await client.session.get({ sessionID: sessionId, directory: directory ?? undefined })
    return requireBoundSessionData(response, "session.get")
  }
  const createSession = async (
    input: BoundSessionCreateInput = {},
    directory?: string | null,
  ): Promise<Session> => {
    assertCurrent()
    const targetDirectory = directory?.trim() || null
    const metadata = withAgentBackendMetadata(input.metadata, input.providerID ?? "")
    if (input.providerID === "pi") {
      if (!targetDirectory) throw new Error("Session directory is required")
      return createPiSessionWithPendingDialogs({
        directory: targetDirectory,
        parentID: input.parentID,
        title: input.title,
        metadata,
      }, {
        runtimeKey,
        request: transport.fetch,
        get,
        delete: deleteSession,
        assertCurrent,
      })
    }

    const response = await client.session.create({
      directory: targetDirectory ?? undefined,
      parentID: input.parentID,
      title: input.title,
      metadata,
    })
    return requireBoundSessionData(response, "session.create")
  }


  const getMessages = async (
    sessionId: string,
    limit?: number,
    directory?: string | null,
  ): Promise<Array<{ info: Message; parts: Part[] }>> => {
    const response = await client.session.messages({
      sessionID: sessionId,
      directory: directory ?? undefined,
      limit,
    })
    return requireBoundSessionData(response, "session.messages")
  }

  async function deleteSession(sessionId: string, directory?: string | null): Promise<boolean> {
    const response = await client.session.delete({ sessionID: sessionId, directory: directory ?? undefined })
    if (response.data === true || response.response?.status === 404) return true
    if (response.response?.status && response.response.status >= 400) {
      throw new BoundSessionOperationError("session.delete", response.response.status)
    }
    return false
  }

  const fork = async (
    sessionId: string,
    messageId?: string,
    providerID?: string,
    directory?: string | null,
  ): Promise<ForkedSession> => {
    const targetDirectory = directory ?? getSessionDirectory(sessionId)
    if (!targetDirectory) throw new Error("Session directory is required")
    assertCurrent()
    const requestBody: ForkAuthorizedRequest = { directory: targetDirectory }
    if (messageId) requestBody.messageId = messageId
    if (providerID) requestBody.providerID = providerID
    const response = await transport.fetch(`/api/openchamber/sessions/${encodeURIComponent(sessionId)}/fork-authorized`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    })
    if (!response.ok) {
      const error = await sessionForkRequestError(response, "Failed to fork session", runtimeKey)
      if (error instanceof RetainedSessionError) throw error
      assertCurrent()
      throw error
    }
    const forkResponse = forkAuthorizedResponseSchema.safeParse(await response.json().catch(() => null))
    if (!forkResponse.success) throw new Error("Invalid session fork response")
    const session = {
      ...forkResponse.data.session,
      directory: forkResponse.data.directory,
    } as ForkedSession
    try {
      assertCurrent()
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("runtime changed")
      await confirmForkDeletion(session, runtimeKey, cause, () => deleteSession(session.id, session.directory))
      throw cause
    }
    return session
  }

  return {
    runtimeKey,
    request: transport.fetch,
    get,
    create: createSession,
    getMessages,
    patchMetadata: (sessionId, directory, updater) => patchSessionMetadataWithTransport(sessionId, directory, updater, {
      client: { getSession: get },
      request: transport.fetch,
      publish: false,
    }),
    fork,
    delete: deleteSession,
    updateTitle: async (sessionId, title, directory) => {
      const response = await client.session.update({
        sessionID: sessionId,
        directory: directory ?? undefined,
        title,
      })
      return requireBoundSessionData(response, "session.update")
    },
    assertCurrent,
    publish: (session, directory) => {
      assertCurrent()
      const sessionDirectory = (session as Session & { directory?: string | null }).directory
        ?? directory
        ?? getSessionDirectory(session.id)
      return commitMetadataSession(session, sessionDirectory)
    },
    finalizeDeletion: (sessionId, directory) => {
      assertCurrent()
      finalizeConfirmedSessionDeletion(sessionId, directory ?? getSessionDirectory(sessionId), runtimeKey)
    },
    release: transport.release,
  }
}

export async function forkSessionWithAuthorization(
  sessionId: string,
  messageId: string | undefined,
  providerID: string | undefined,
  directory: string | null | undefined,
  expectedRuntimeKey = getRuntimeKey(),
  assertCurrent?: SessionMutationGuard,
): Promise<ForkedSession> {
  assertSessionMutationCurrent(expectedRuntimeKey, assertCurrent)
  const operation = bindSessionOperation()
  try {
    const session = await operation.fork(sessionId, messageId, providerID, directory)
    try {
      assertSessionMutationCurrent(expectedRuntimeKey, assertCurrent)
      operation.assertCurrent()
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("runtime changed")
      await confirmForkDeletion(session, operation.runtimeKey, cause, () => (
        operation.delete(session.id, session.directory)
      ))
      throw cause
    }
    return operation.publish(session, directory)
  } finally {
    operation.release()
  }
}

export async function setLinkedIssue(
  sessionId: string,
  directory: string | null | undefined,
  issue: LinkedIssue,
  linked: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withLinkedIssue(metadata, issue, linked))
}

export async function setContextObligatoryMessage(
  sessionId: string,
  directory: string | null | undefined,
  message: ContextObligatoryMessage,
  pinned: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withContextObligatoryMessage(metadata, message, pinned))
}

async function cleanupReviewMetadataBeforeDelete(
  sessionId: string,
  directory?: string | null,
  expectedRuntimeKey?: string,
): Promise<void> {
  if (isStaleRuntime(expectedRuntimeKey)) return
  let session: Session
  try {
    session = await opencodeClient.getSession(sessionId, directory ?? getSessionDirectory(sessionId))
  } catch {
    return
  }
  if (isStaleRuntime(expectedRuntimeKey)) return

  const unlinkParent = async (originalSessionID: string, unlink: (metadata: SessionMetadataRecord) => SessionMetadataRecord) => {
    try {
      await patchSessionMetadata(originalSessionID, directory ?? getSessionDirectory(originalSessionID), unlink, expectedRuntimeKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) return
      console.warn("[session-actions] linked-session metadata cleanup failed before delete", error)
    }
  }

  if (isReviewSession(session)) {
    const originalSessionID = getOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutReviewSessionLink(metadata, sessionId))
    return
  }

  if (isBtwSession(session)) {
    const originalSessionID = getBtwOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutBtwSessionLink(metadata, sessionId))
    return
  }

  // Deleting or archiving a session that has an active btw fork also removes
  // the fork: it is a temporary session that only exists for its parent's
  // panel. Best-effort — a failed fork delete must not block the parent's
  // operation; the orphaned fork stays visible in the sidebar.
  const btwSessionID = getBtwSessionID(session)
  if (btwSessionID) {
    try {
      if (isStaleRuntime(expectedRuntimeKey)) return
      await deleteSession(btwSessionID, { expectedRuntimeKey })
    } catch (error) {
      console.warn("[session-actions] failed to delete btw fork before parent delete", error)
    }
  }
}

/** Remove a server-confirmed session from every live child store that has it. */
function removeSessionFromLiveStores(sessionId: string, preferredDirectory?: string): SessionListSnapshot[] {
  if (!_childStores) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    if (!current.session.some((session) => session.id === sessionId)) {
      continue
    }
    snapshots.push({ directory })
    store.setState({
      session: current.session.filter((session) => session.id !== sessionId),
      ...sessionMutationPatch(current, sessionId, true),
    })
  }

  return snapshots
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

/**
 * Commit a server-confirmed deletion.
 *
 * `expectedRuntimeKey` is the runtime the deletion was confirmed on. It is
 * forwarded to `cleanupPersistedSessionState`, which rejects an identity whose
 * runtime is no longer active. Passing the live `getRuntimeKey()` here would
 * make that existing check a tautology, so the captured key is required to keep
 * it meaningful. Callers must still reject a stale runtime themselves, because
 * the in-memory live/global/UI stores mutated below are not runtime-scoped.
 */
export function finalizeConfirmedSessionDeletion(
  sessionId: string,
  sessionDirectory?: string,
  expectedRuntimeKey = getRuntimeKey(),
): void {
  const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory)
  invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
  useGlobalSessionsStore.getState().removeSessions([sessionId])
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  cleanupSessionWorktreeMetadata(sessionId)
  if (sessionDirectory) {
    cleanupPersistedSessionState({
      runtimeKey: expectedRuntimeKey,
      directory: sessionDirectory,
      sessionId,
    })
  }
}

async function cleanupDeletedChatDirectory(directory: string | undefined, deleteDirectory: boolean): Promise<void> {
  if (!directory || !deleteDirectory) return
  try {
    await deleteChatDirectory(directory)
  } catch (error) {
    console.warn("[session-actions] deleted chat directory cleanup failed", error)
  }
}

export type DeleteSessionOptions = {
  /** Directory returned by a just-created session that is not indexed yet. */
  directory?: string | null
  /** Skip parent/child metadata cleanup for an unpublished failed fork. */
  skipRelationshipCleanup?: boolean
  /** Runtime key the deletion is scoped to. */
  expectedRuntimeKey?: string
  /** Captured transport client for a runtime-bound compensation delete. */
  client?: Pick<typeof opencodeClient, "deleteSession">
  /** Reject a same-runtime transport/client change before local finalization. */
  assertCurrent?: SessionMutationGuard
}

/**
 * Delete one session.
 *
 * The runtime is rechecked before the request and again before any store is
 * reconciled, so a response produced by the previous runtime cannot mutate the
 * current runtime's state. Session IDs are not unique across runtimes, so
 * committing a stale deletion could otherwise evict an unrelated session and
 * erase its persisted queue, todos, drafts, folders, and pins.
 *
 * A `404` is treated as an already-completed deletion, but only when it is
 * still authoritative for the captured runtime. After a runtime change the
 * `404` describes either the previous runtime or a runtime this session never
 * belonged to; neither justifies committing cleanup here, so the action reports
 * failure and leaves reconciliation to the next authoritative load.
 */
export async function deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<boolean> {
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()
  const isCurrent = (): boolean => {
    if (isStaleRuntime(expectedRuntimeKey)) return false
    try {
      options?.assertCurrent?.()
      return true
    } catch {
      return false
    }
  }
  if (!isCurrent()) return false
  const sessionDirectory = options?.directory ?? getSessionDirectory(sessionId)
  const sessionSnapshot = getGlobalSessionSnapshot(sessionId)
  const deleteManagedDirectory = Boolean(sessionSnapshot && sessionSnapshot.parentID == null)
  const client = options?.client ?? opencodeClient
  try {
    if (!options?.skipRelationshipCleanup) {
      await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
      if (!isCurrent()) return false
    }
    const deleted = await client.deleteSession(sessionId, sessionDirectory)
    if (!isCurrent()) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, expectedRuntimeKey)
    await cleanupDeletedChatDirectory(sessionDirectory, deleteManagedDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    // The server cascade-deletes child sessions when the parent is removed.
    // Subsequent delete attempts for those children return 404; treat as
    // success since the session was already deleted by the cascade.
    if ((error as { status?: number })?.status === 404) {
      if (!isCurrent()) return false
      finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, expectedRuntimeKey)
      await cleanupDeletedChatDirectory(sessionDirectory, deleteManagedDirectory)
      return true
    }
    return false
  }
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(
  sessionId: string,
  directory: string,
  expectedRuntimeKey = getRuntimeKey(),
): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionSnapshot = getGlobalSessionSnapshot(sessionId)
  const deleteManagedDirectory = Boolean(sessionSnapshot && sessionSnapshot.parentID == null)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, directory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const deleted = await opencodeClient.deleteSession(sessionId, directory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, directory, expectedRuntimeKey)
    await cleanupDeletedChatDirectory(directory, deleteManagedDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSessionInDirectory failed", error)
    if ((error as { status?: number })?.status === 404) {
      if (isStaleRuntime(expectedRuntimeKey)) return false
      finalizeConfirmedSessionDeletion(sessionId, directory, expectedRuntimeKey)
      await cleanupDeletedChatDirectory(directory, deleteManagedDirectory)
      return true
    }
    return false
  }
}

export type DeleteSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Delete several sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When the runtime
 * changes mid-batch, the sessions already committed on the captured runtime
 * stay in `deletedIds` and every ID that was not committed there is reported in
 * `failedIds`, so existing partial-failure feedback stays truthful.
 */
export async function deleteSessions(
  ids: string[],
  options?: DeleteSessionsOptions,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await deleteSession(id, { expectedRuntimeKey })) deletedIds.push(id)
    else failedIds.push(id)
  }

  return { deletedIds, failedIds }
}

/**
 * Archive one session.
 *
 * `expectedRuntimeKey` defaults to the active runtime when the action starts.
 * Callers may supply a key captured earlier when confirmation spans a runtime
 * switch. When the runtime changes, the action stops and returns `false`
 * without reconciling any store, so a response
 * produced by the previous runtime cannot mutate the current runtime's live or
 * global session state. A session the server already archived before the switch
 * stays archived on that runtime and is re-read from the server the next time
 * the runtime is loaded.
 */
export async function archiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const archivedAt = Date.now()
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const archived = await opencodeClient.updateSession(sessionId, { time: { archived: archivedAt } }, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (!archived) {
      throw new Error("session.update failed: server did not return the archived session")
    }
    const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory)
    invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
    useGlobalSessionsStore.getState().upsertSession(archived)
    const ui = useSessionUIStore.getState()
    if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    return false
  }
}

export type ArchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Archive several sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `archivedIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing the existing partial-failure feedback instead of silently dropping
 * work.
 */
export async function archiveSessions(
  ids: string[],
  options?: ArchiveSessionsOptions,
): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  const archivedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await archiveSession(id, expectedRuntimeKey)) archivedIds.push(id)
    else failedIds.push(id)
  }

  return { archivedIds, failedIds }
}

/**
 * Sentinel written to `time.archived` when restoring a session.
 *
 * The OpenCode server has no HTTP path to clear `time.archived` back to NULL:
 * `session.update` only applies the field when the payload carries a finite
 * number (`archived !== undefined`), so omitting the key is a no-op and `null`
 * is silently ignored. Writing `0` is the only value that makes every reader
 * treat the session as active again: the UI, the event reducer, and the
 * OpenCode app/TUI all classify archive state by truthiness of
 * `time.archived`, and `0` is falsy. The one place that still excludes such a
 * session is the server's own `time_archived IS NULL` list filter, so the
 * global session cache loads with the inclusive `archived` flag and splits
 * client-side instead of relying on that filter (see
 * `useGlobalSessionsStore.loadSessions`).
 */
const UNARCHIVED_TIMESTAMP = 0

/**
 * Restore one archived session back to the active list.
 *
 * Same contract as `archiveSession`: waits for server confirmation before
 * reconciling stores, and rejects stale runtimes so a response produced by a
 * previous runtime cannot mutate the current runtime's state. The global
 * session cache is updated directly (the sidebar reads active/archived
 * buckets from it); the live directory store is re-populated by the
 * authoritative `session.updated` event the server publishes for the update.
 */
export async function unarchiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  try {
    const restored = await opencodeClient.updateSession(sessionId, { time: { archived: UNARCHIVED_TIMESTAMP } }, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (!restored) {
      throw new Error("session.update failed: server did not return the restored session")
    }
    if (restored.time?.archived) {
      throw new Error("session.update failed: server kept the session archived")
    }
    useGlobalSessionsStore.getState().upsertSession(restored)
    if (sessionDirectory) registerSessionDirectory(sessionId, sessionDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] unarchiveSession failed", error)
    return false
  }
}

export type UnarchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Restore several archived sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `restoredIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing truthful partial-failure feedback.
 */
export async function unarchiveSessions(
  ids: string[],
  options?: UnarchiveSessionsOptions,
): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  const restoredIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await unarchiveSession(id, expectedRuntimeKey)) restoredIds.push(id)
    else failedIds.push(id)
  }

  return { restoredIds, failedIds }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const session = await opencodeClient.updateSession(sessionId, { title }, sessionDirectory)
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.share({ sessionID: sessionId, directory: sessionDirectory })
  const session = stripSessionDiffSnapshots(assertSdkData(result, "session.share"))
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: sessionDirectory })
  // A successful unshare is authoritative even when the upstream response
  // echoes the pre-mutation session with its old share URL. Normalize that
  // stale field at the action boundary before publishing to either store.
  const session = {
    ...stripSessionDiffSnapshots(assertSdkData(result, "session.unshare")),
    share: undefined,
  }
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

// ID generator matching OpenCode's Identifier.ascending wire format.
// Uses BigInt(timestamp) * 0x1000 + counter, encoded as 6 hex bytes + random base62.
// The 6-byte prefix rolls over, so this value is identity only; transcript
// chronology is always derived from message.time.created.
let lastIdTimestamp = 0
let idCounter = 0

function ascendingId(prefix: string): string {
  const now = Date.now()
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now
    idCounter = 0
  }
  idCounter += 1

  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter)
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }

  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let rand = ""
  for (let i = 0; i < 14; i++) {
    rand += chars[Math.floor(Math.random() * 62)]
  }

  return `${prefix}_${hex}${rand}`
}

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 */
export async function optimisticSend(input: {
  runtimeKey?: string
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  onOptimisticInsert?: () => void
  onMessageID?: (messageID: string) => void
  beforeOptimisticInsert?: () => void
  /** The actual API call — receives optimistic IDs so server echoes replace the local parts in-place */
  send: (messageID: string, parts: Part[]) => Promise<void>
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }
  const optimisticAdd = _optimisticAdd
  const optimisticRemove = _optimisticRemove
  const optimisticConfirm = _optimisticConfirm

  const assertRuntimeUnchanged = () => {
    if (input.runtimeKey && input.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }

  assertRuntimeUnchanged()
  await waitForConnectionOrThrow()
  input.beforeOptimisticInsert?.()
  assertRuntimeUnchanged()

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  const stateBeforeSend = store.getState()
  const sessionBeforeSend = stateBeforeSend.session.find((session) => session.id === input.sessionId)
  const revertMessageID = sessionBeforeSend?.revert?.messageID
  const messagesBeforeSend = stateBeforeSend.message[input.sessionId] ?? []
  const revertedMessages = messagesFrom(messagesBeforeSend, revertMessageID)
  const revertedParts = new Map(
    revertedMessages.map((message) => [message.id, stateBeforeSend.part[message.id] ?? []] as const),
  )

  if (revertMessageID) {
    const session = stateBeforeSend.session.map((candidate) => (
      candidate.id === input.sessionId ? { ...candidate, revert: undefined } as Session : candidate
    ))
    const message = {
      ...stateBeforeSend.message,
      [input.sessionId]: messagesBefore(messagesBeforeSend, revertMessageID),
    }
    const part = { ...stateBeforeSend.part }
    for (const revertedMessage of revertedMessages) delete part[revertedMessage.id]
    store.setState({ session, message, part })

    // A server-backed user message can still remain in the loader's optimistic
    // shadow until a page fetch confirms it. Forget the reverted branch there
    // too, or the next tail refresh will merge those deleted messages back in.
    for (const revertedMessage of revertedMessages) {
      _optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID: revertedMessage.id,
      })
    }
  }

  const messageID = ascendingId("msg")
  input.onMessageID?.(messageID)
  const optimisticParts: Part[] = []
  if (input.content.trim()) {
    optimisticParts.push({ id: ascendingId("prt"), type: "text", text: input.content } as Part)
  }
  if (input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: ascendingId("prt"), type: "file", mime: f.mime, url: f.url, filename: f.filename } as Part)
    }
  }

  const optimisticMessage = {
    id: messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: `${input.providerID}/${input.modelID}`,
    metadata: {} as Record<string, unknown>,
    time: { created: Date.now(), completed: 0 },
  } as unknown as Message

  // Insert into store + register in shadow Map (for mergeOptimisticPage cleanup)
  optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })
  input.onOptimisticInsert?.()

  // Set busy status
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
  })

  try {
    assertRuntimeUnchanged()
    await input.send(messageID, optimisticParts)
  } catch (error) {
    const status = getErrorStatus(error)
    const ambiguousFailure = isAmbiguousSendFailure(error)
    const acceptedRecords = ambiguousFailure
      ? await fetchRecentSendConfirmationRecords(input.sessionId, messageID, targetDirectory)
      : null

    if (acceptedRecords) {
      materializeConfirmedSendRecords(store, input.sessionId, messageID, acceptedRecords)
      optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID,
      })
      return
    }

    // The rollback below makes the user's message disappear with no other
    // trace, and the composer intentionally stays silent for transport-level
    // failures. Record the failure so the About dialog's diagnostics report can
    // answer "it disappeared and nothing happened" with an actual cause.
    // `reason` is truncated by the recorder: a rejected send echoes the
    // provider/OpenCode response body, which this log has no reason to keep.
    const failureRecord = {
      sessionId: input.sessionId,
      messageId: messageID,
      directory: targetDirectory ?? null,
      status,
      ambiguous: ambiguousFailure,
      confirmationChecked: ambiguousFailure,
      reason: error instanceof Error ? error.message : String(error),
    }
    recordSendFailure(failureRecord)
    console.warn("[session-actions] prompt send rejected; rolling back optimistic message", failureRecord)

    // Rollback via optimistic infrastructure
    optimisticRemove({
      sessionID: input.sessionId,
      directory: targetDirectory,
      messageID,
    })
    const rollbackState = store.getState()
    let session = rollbackState.session
    let message = rollbackState.message
    let part = rollbackState.part

    if (revertMessageID) {
      session = rollbackState.session.map((candidate) => (
        candidate.id === input.sessionId ? { ...candidate, revert: sessionBeforeSend?.revert } as Session : candidate
      ))
      message = {
        ...rollbackState.message,
        [input.sessionId]: mergeMessages(rollbackState.message[input.sessionId] ?? [], revertedMessages),
      }
      part = { ...rollbackState.part }
      for (const [revertedMessageID, parts] of revertedParts) {
        part[revertedMessageID] = parts
      }
    }

    store.setState({
      session,
      message,
      part,
      session_status: {
        ...rollbackState.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  }
}

async function fetchRecentSendConfirmationRecords(
  sessionId: string,
  messageID: string,
  directory?: string | null,
): Promise<Array<{ info: Message; parts?: Part[] }> | null> {
  // Bounded: a connection that never returns must still let the send fail
  // rather than hang the composer.
  const reconnectDeadline = Date.now() + SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS
  while (!useConfigStore.getState().isConnected && Date.now() < reconnectDeadline) {
    await wait(SEND_CONFIRMATION_RECONNECT_POLL_MS)
  }

  for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS * 2 ** (attempt - 1))
    try {
      const result = await sdk().session.messages({
        sessionID: sessionId,
        directory: directory ?? undefined,
        limit: SEND_CONFIRMATION_REFETCH_LIMIT,
      })
      const records = (assertSdkSuccess(result, "session.messages") ?? [])
        .filter((record: { info?: { id?: string } }) => !!record?.info?.id) as Array<{ info: Message; parts?: Part[] }>
      if (records.some((record) => record.info.id === messageID)) {
        return records
      }
    } catch {
      // Confirmation is best-effort; if it fails, keep the original send error path.
    }
  }
  return null
}

function materializeConfirmedSendRecords(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  records: Array<{ info: Message; parts?: Part[] }>,
): void {
  store.setState((state) => {
    const currentMessages = state.message[sessionId]
    const message = { ...state.message }
    const part = { ...state.part }
    if (currentMessages) {
      const nextMessages = currentMessages.filter((message) => message.id !== messageID)
      message[sessionId] = nextMessages
    }
    delete part[messageID]

    const materialized = materializeSessionSnapshots(
      { ...state, message, part },
      sessionId,
      records.map((record) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  // The abort must carry the SESSION'S directory, not the active UI directory:
  // OpenCode routes the request to the per-directory instance, and an abort
  // sent to the wrong instance cancels nothing while still returning 200 true
  // (the "stop button does nothing" report — sessions in another project/
  // worktree than the UI's current directory could never be aborted).
  const { directory } = dirStoreForSession(sessionId)
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
  directoryOverride?: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = directoryOverride
    || resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const client = directoryOverride
    ? opencodeClient.getScopedSdkClient(directoryOverride)
    : getRequestReplyClient("permission", sessionId, requestId)
  const result = await client.permission.reply({
    requestID: requestId,
    reply: response,
    ...(directory ? { directory } : {}),
  })
  if (assertSdkData(result, "permission.reply") !== true) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
      requestID: requestId,
      reply: "reject",
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "permission.reply") !== true) {
      throw new Error("Permission dismissal failed")
    }
  } catch (error) {
    if (isPermissionRequestNotFoundError(error)) {
      removePermissionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/**
 * Dismiss every pending permission for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a permission prompt is open must cancel/supersede the
 * open permission so it cannot linger or block the new turn.
 *
 * The permissions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `permission.reply` round-trip. Each permission is then formally rejected on
 * the backend via `permission.reply` with `reply: "reject"`, which fires
 * `permission.replied` for reconciliation.
 *
 * Returns true when at least one permission was dismissed. Rejection failures are
 * swallowed (a stranded permission must never block the send);
 * PermissionNotFoundError also clears the stale entry from the child store via
 * {@link dismissPermission}.
 *
 * NOTE: rejecting unblocks the agent's tool but does NOT end its turn. Callers
 * that need to send the next message right away (the chat send path) must also
 * queue the message so the OpenCode runner reaches `idle` — otherwise the new
 * prompt arrives while the run is still active and is discarded by the runner's
 * `ensureRunning`.
 */
export async function dismissOpenPermissionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const permissionsBySession = state.permission ?? {}
    for (const scopedId of scopedIds) {
      const requests = permissionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the permissions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removePermissionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await dismissPermission(scopedSessionId, requestId)
      } catch (error) {
        if (isPermissionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // permission.asked / permission.replied event reconciles the store.
        console.error("[session-actions] Failed to dismiss open permission on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const normalizedAnswers = answers.length === 0
      ? []
      : Array.isArray(answers[0])
        ? answers as string[][]
        : [answers as string[]]
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reply({
      requestID: requestId,
      answers: normalizedAnswers,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reply") !== true) {
      throw new Error("Question reply failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

export async function rejectQuestion(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reject({
      requestID: requestId,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reject") !== true) {
      throw new Error("Question rejection failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

/**
 * Dismiss every pending question for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a question prompt is open must cancel/supersede the
 * open question so it cannot linger or strand the session in a half-answered
 * state.
 *
 * The questions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `question.reject` round-trip. Each question is then formally rejected on the
 * backend, which fires `question.rejected` for reconciliation.
 *
 * Returns true when at least one question was dismissed. Rejection failures are
 * swallowed (a stranded question must never block the send);
 * QuestionNotFoundError also clears the stale entry from the child store via
 * {@link rejectQuestion}.
 *
 * NOTE: rejecting unblocks the agent's tool but does NOT end its turn. Callers
 * that need to send the next message right away (the chat send path) must also
 * abort the session so the OpenCode runner reaches `idle` — otherwise the new
 * prompt arrives while the run is still active and is discarded by the runner's
 * `ensureRunning`.
 */
export async function dismissOpenQuestionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const questionsBySession = state.question ?? {}
    for (const scopedId of scopedIds) {
      const requests = questionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the questions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removeQuestionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await rejectQuestion(scopedSessionId, requestId)
      } catch (error) {
        if (isQuestionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // question.asked / question.rejected event reconciles the store.
        console.error("[session-actions] Failed to dismiss open question on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call the runtime revert endpoint and merge returned session
 * 5. Set pendingInputText so the reverted message text appears in the input
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()

  // Abort if busy before mutating session state
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore abort errors
    }
  }

  // Extract message text for prompt restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  let messageText = ""
  let submittedFileParts: Array<Record<string, unknown>> = []
  if (targetMsg && targetMsg.role === "user") {
    const parts = state.part[messageId] ?? []
    const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
    messageText = textParts
      .map((p: Record<string, unknown>) => (p as { text?: string }).text || (p as { content?: string }).content || "")
      .join("\n")
      .trim()
    // Snapshot file parts for later restoration to the input.
    // Exclude synthetic file parts (server-generated file content that should
    // not be restored to the composer).
    submittedFileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>
  }

  // Optimistically set only the revert marker. Keep messages and parts in the
  // local store; visible-message selectors derive the displayed timeline from
  // session.revert. This matches the server model and preserves reverted
  // messages for the restore dock without maintaining a separate shadow copy.
  const prevRevert = (() => {
    const s = state.session.find((s) => s.id === sessionId)
    return (s as Session & { revert?: unknown })?.revert
  })()
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  const patch: Record<string, unknown> = {}

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
    patch.session = sessions
  }

  store.setState(patch)

  // Save input store state before mutations — if the API fails we need to
  // roll back both text and attachments to their previous values.
  const prevInputAttachments = [...useInputStore.getState().attachedFiles]
  const prevInputText = useInputStore.getState().pendingInputText
  const prevInputMode = useInputStore.getState().pendingInputMode

  // Restore reverted message text and file attachments to input
  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }

  // Restore file/image attachments from the target message.
  // Clear existing attachments first — previous revert's attachments
  // must not carry over, even when the current message has no files.
  restoreFilePartsToInput(submittedFileParts)

  // Call SDK and merge authoritative result into store
  try {
    const revertedSession = await opencodeClient.revertSession(sessionId, messageId, undefined, directory)
    const current = store.getState()
    const updated = [...current.session]
    const idx = updated.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      updated[idx] = revertedSession
      store.setState({ session: updated })
    }
    if (directory) {
      sessionEvents.requestGitRefresh({ directory })
    }
  } catch (err) {
    // Rollback: restore removed messages + revert marker
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
    }
    store.setState({
      session: rollback,
    })
    // Rollback input store: restore previous text and attachments
    useInputStore.setState({
      pendingInputText: prevInputText,
      pendingInputMode: prevInputMode,
      attachedFiles: prevInputAttachments,
    })
    throw err
  }
}

export async function refetchSessionMessages(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const loader = getImperativeSessionMessageLoader()
  if (loader && directory) {
    await loader.refreshTail({ directory, sessionID: sessionId }, MESSAGE_REFETCH_LIMIT)
    const snapshot = loader.getSnapshot({ directory, sessionID: sessionId })
    if (snapshot.status === "error") throw snapshot.error ?? new Error("Session message refresh failed")
    return
  }

  // Actions can run in isolated tests before SyncProvider binds the shared
  // loader. The application runtime always takes the shared path above.
  const result = await sdk().session.messages({ sessionID: sessionId, directory, limit: MESSAGE_REFETCH_LIMIT })
  const records = (assertSdkSuccess(result, "session.messages") ?? [])
    .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  if (records.length === 0) return

  store.setState((state) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionId,
      records.map((record: { info: Message; parts?: Part[] }) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()
  const previousMessageCount = state.message[sessionId]?.length ?? 0

  // Abort if busy
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore
    }
  }

  const result = await sdk().session.unrevert({ sessionID: sessionId, directory })
  const unrevertedSession = assertSdkData(result, "session.unrevert")
  const current = store.getState()
  const sessions = [...current.session]
  const idx = sessions.findIndex((s) => s.id === sessionId)
  if (idx >= 0) {
    sessions[idx] = unrevertedSession
    store.setState({ session: sessions })
  }
  for (let attempt = 0; attempt < UNREVERT_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(UNREVERT_REFETCH_RETRY_MS)
    await refetchSessionMessages(sessionId)
    const nextMessageCount = store.getState().message[sessionId]?.length ?? 0
    if (nextMessageCount > previousMessageCount) return
  }
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call the runtime fork endpoint
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string, providerID: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const operation = bindSessionOperation()
  try {
    const state = store.getState()

    // Extract message text and file attachments for input restoration.
    // Only non-synthetic text parts — the server adds file content as synthetic
    // text parts that should not be restored. File parts (images, pasted
    // screenshots) are user-originated and must be restored.
    const parts = state.part[messageId] ?? []
    const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
    const messageText = textParts
      .map((p: Part) => ((p as Record<string, unknown>).text as string) || ((p as Record<string, unknown>).content as string) || "")
      .join("\n")
      .trim()
    const fileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>

    const forkedSession = await operation.fork(sessionId, messageId, providerID, directory)
    try {
      operation.assertCurrent()
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("runtime changed")
      await confirmForkDeletion(forkedSession, operation.runtimeKey, cause, () => (
        operation.delete(forkedSession.id, forkedSession.directory)
      ))
      throw cause
    }

    // There are no awaits after this final guard. Route registration, global
    // state, directory state, and input restoration therefore publish together.
    const targetStore = forkedSession.directory === directory
      ? store
      : dirStoreForDirectory(forkedSession.directory)
    const current = targetStore.getState()
    const sessions = [...current.session]
    const searchResult = Binary.search(sessions, forkedSession.id, (candidate) => candidate.id)
    if (!searchResult.found) sessions.splice(searchResult.index, 0, forkedSession)
    operation.publish(forkedSession, forkedSession.directory)
    if (!searchResult.found) targetStore.setState({ session: sessions })
    useSessionUIStore.getState().setCurrentSession(forkedSession.id, forkedSession.directory)
    if (messageText) {
      useInputStore.setState({
        pendingInputText: messageText,
        pendingInputMode: "replace" as const,
      })
    }
    restoreFilePartsToInput(fileParts)
  } finally {
    operation.release()
  }
}

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return
  await getImperativeSessionMessageLoader()?.ensure(
    { directory: resolvedDir, sessionID },
    { reason: "navigation" },
  )
}
