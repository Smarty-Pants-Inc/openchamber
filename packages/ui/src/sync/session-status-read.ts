import type { StoreApi } from 'zustand'
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch'
import { normalizeProjectPath } from '@/lib/projectResolution'
import { captureSessionStatusEventVersions, getSessionStatusEventVersion, useGlobalSessionStatusStore, applyGlobalSessionStatusSnapshot, isForeignOrdinarySessionStatus } from './global-session-status'
import type { DirectoryStore } from './child-store'
import type { State } from './types'

// Capture before dispatch/scheduling, including IDs not yet known to the caller.
export const captureSessionStatusRead = (local?: State['session_status']) => ({
  scope: captureRuntimeRequestScope(),
  versions: captureSessionStatusEventVersions(),
  local,
})
export type SessionStatusRead = ReturnType<typeof captureSessionStatusRead>
export const isSessionStatusReadCurrent = (read: SessionStatusRead) => isRuntimeRequestScopeCurrent(read.scope)

export function heldSessionStatusIds(
  read: SessionStatusRead,
  directory: string,
  raw: Record<string, { type?: string }>,
  known: Iterable<string>,
  current?: State['session_status'],
): Set<string> {
  const ids = new Set([...known, ...Object.keys(raw), ...Object.keys(current ?? {}), ...Object.keys(read.local ?? {})])
  const normalized = normalizeProjectPath(directory) ?? directory
  const indexed = useGlobalSessionStatusStore.getState().statusById
  for (const [id, entry] of indexed) {
    if (entry.directory === normalized) ids.add(id)
  }
  return new Set([...ids].filter((id) => getSessionStatusEventVersion(id) !== (read.versions.get(id) ?? 0)
    || (read.local !== undefined && current?.[id] !== read.local[id])
    || isForeignOrdinarySessionStatus(indexed.get(id), normalized)))
}

// The bootstrap callback publishes a merged child patch and the same held-ID coverage globally.
// Keep unrelated patch fields and preserve a held removal even when it was already absent.
export function commitDirectoryBootstrapPatch(
  store: StoreApi<DirectoryStore>, directory: string, patch: Partial<State>, read?: SessionStatusRead,
): void {
  if (!patch.session_status || !read) {
    store.setState(patch)
    return
  }
  if (!isSessionStatusReadCurrent(read)) return
  const current = store.getState()
  const known = current.session.map((session) => session.id)
  const held = heldSessionStatusIds(read, directory, patch.session_status, known, current.session_status)
  const merged = { ...patch.session_status }
  for (const id of held) {
    if (current.session_status[id] !== undefined) merged[id] = current.session_status[id]
    else delete merged[id]
  }
  store.setState({ ...patch, session_status: merged })
  applyGlobalSessionStatusSnapshot(directory, patch.session_status, known, held)
}
