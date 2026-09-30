// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationBase = {
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  /** What OpenCode reported for the failed turn; both null when it gave no details. */
  error?: { name: string | null; message: string | null }
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  }

  for (const n of list) {
    if (n.viewed) continue

    if (n.session) {
      index.session.unseenCount[n.session] = (index.session.unseenCount[n.session] ?? 0) + 1
      if (n.type === "error") index.session.unseenHasError[n.session] = true
    }
    if (n.directory) {
      index.project.unseenCount[n.directory] = (index.project.unseenCount[n.directory] ?? 0) + 1
      if (n.type === "error") index.project.unseenHasError[n.directory] = true
    }
  }

  return index
}


// smarty-code#924/#986: a turn this page saw stop with an error ("started, then stopped") must still say so after a
// reload of this tab, instead of the 5 s "did not start" notice (the native journal may hold no terminal entry for a
// killed reply, and nothing may be invented there). So the newest error per session, as this page observed it live,
// is kept in this tab's sessionStorage and restored as viewed. Nothing else is persisted: turn completions and unseen
// counts start fresh. A newer real message still hides it (SessionErrorNotice compares times).
const STOPPED_KEY = "oc.session-stopped.v1"
const STOPPED_MAX = 50
const STOPPED_TTL_MS = 1000 * 60 * 60 * 24

function tabStorage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage } catch { return null }
}

function restoreStopped(): Notification[] {
  const raw = tabStorage()?.getItem(STOPPED_KEY)
  if (!raw) return []
  try {
    const cutoff = Date.now() - STOPPED_TTL_MS
    const records = JSON.parse(raw) as ErrorNotification[]
    return Array.isArray(records)
      ? records.filter((n) => n?.type === "error" && typeof n.session === "string" && typeof n.time === "number" && n.time >= cutoff)
        .map((n) => ({ type: "error" as const, session: n.session, directory: typeof n.directory === "string" ? n.directory : undefined,
          time: n.time, viewed: true, error: n.error ? { name: n.error.name ?? null, message: n.error.message ?? null } : undefined }))
      : []
  } catch { return [] }
}

function keepStopped(list: Notification[]) {
  const storage = tabStorage()
  if (!storage) return
  const newest = new Map<string, ErrorNotification>()
  for (const n of list) if (n.type === "error" && n.session) newest.set(n.session, n)
  const records = [...newest.values()].sort((a, b) => a.time - b.time).slice(-STOPPED_MAX)
  try { storage.setItem(STOPPED_KEY, JSON.stringify(records)) } catch { /* full or blocked: live notices still work */ }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string) => void
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string) => number
  sessionHasError: (sessionId: string) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

const restored = restoreStopped()

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: restored,
  index: buildIndex(restored),

  append: (notification) => {
    const current = get().list
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
    if (notification.type === "error") keepStopped(next)
  },

  markSessionViewed: (sessionId) => {
    const current = get()
    const count = current.index.session.unseenCount[sessionId] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.session === sessionId && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  markProjectViewed: (directory) => {
    const current = get()
    const count = current.index.project.unseenCount[directory] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.directory === directory && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
  sessionHasError: (sessionId) => get().index.session.unseenHasError[sessionId] ?? false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
}))

// ---------------------------------------------------------------------------
// Imperative API for non-React code (event handler in sync-context)
// ---------------------------------------------------------------------------

export function appendNotification(notification: Notification) {
  useNotificationStore.getState().append(notification)
}

export function markSessionViewed(sessionId: string) {
  useNotificationStore.getState().markSessionViewed(sessionId)
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((s) => s.index.session.unseenCount[sessionId] ?? 0)
}

/** The newest error OpenCode reported for this session, viewed or not. */
export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useNotificationStore((s) => {
    if (!sessionId) return null
    for (let index = s.list.length - 1; index >= 0; index -= 1) {
      const notification = s.list[index]
      if (notification.session === sessionId && notification.type === "error") return notification
    }
    return null
  })
}

