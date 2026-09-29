import { toast } from '@/components/ui/toast'
import { reportClientError } from '@/lib/clientErrorReport'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { opencodeClient } from '@/lib/opencode/client'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { visibleProjects, useProjectsStore } from '@/stores/useProjectsStore'
import type { Session } from '@opencode-ai/sdk/v2/client'
import { readLastActiveSession } from './last-session-cache'

/**
 * smarty-code#775 (folds #761): the page used to drop a session that is no longer available (its Pi ended, or its
 * worktree left the catalog) and land on an empty draft without a word. Say so once, in #758's words. Not the 404's own
 * text: the gateway has more than one ("Unknown Pi session in requested project" is not for a person). The draft stays usable.
 * ponytail: a toast, not a new layout slot; it is the first sign, and the draft underneath is the person's next step.
 */
// Sessions already checked (told gone, or answered by anything but a 404): never read again until listed again. Forgetting
// a non-404 answer made every store commit read it again: the 3.52 read storm (code-catalog, #126).
const told = new Set<string>()
const keyOf = (runtimeKey: string, sessionId: string) => JSON.stringify([runtimeKey, sessionId])

type Read = (sessionId: string, directory: string) => Promise<{ status?: number }>
const readSession: Read = async (sessionId, directory) => {
  const result = await opencodeClient.getScopedSdkClient(directory).session.get({ sessionID: sessionId })
  return { status: result.response?.status }
}

/** `listed`: the session's directory is still a live project (then its own read decides: only a 404 is "gone"). */
export async function noteGoneSession(sessionId: string, directory: string | null, listed: boolean, read: Read = readSession): Promise<boolean> {
  const runtimeKey = getRuntimeKey(), key = keyOf(runtimeKey, sessionId)
  if (told.has(key)) return false
  told.add(key)
  if (listed && directory) {
    const answer = await read(sessionId, directory).catch(() => null)
    // Only the gateway's definite 404 says gone; a failed or other read says nothing, and is not read again until the
    // session is listed again (then it may be checked afresh).
    if (answer?.status !== 404) return false
  }
  if (getRuntimeKey() !== runtimeKey) { told.delete(key); return false }
  toast.warning(formatMessage(useI18nStore.getState().dictionary, 'chat.container.sessionGone', {}), { duration: 15_000 })
  reportClientError({ kind: 'session.gone', sessionID: sessionId, runtimeKey, operationId: sessionId })
  return true
}

/**
 * The remembered session (a reload or its link) that a managed restore is about to drop because it is no longer listed:
 * said gone before `restoreManagedSessionSelection` clears it. Called by its callers, with the same preconditions, so the
 * branding-ledger-bound session-ui-store stays unchanged.
 */
export function noteRememberedGone(sessions: readonly Session[], options?: { chosen?: boolean }): void {
  const projects = useProjectsStore.getState()
  if (!projects.managedCatalogAdmitted || projects.managedCatalogStatus !== 'ready') return
  if (projects.managedSessionHold?.pending && !options?.chosen) return
  const runtimeKey = getRuntimeKey()
  // A listed session may be checked afresh if it leaves the list again.
  for (const entry of sessions) told.delete(keyOf(runtimeKey, entry.id))
  const persisted = readLastActiveSession(runtimeKey.trim() || 'default')
  if (!persisted || sessions.some(entry => entry.id === persisted.sessionId)) return
  void noteGoneSession(persisted.sessionId, persisted.directory ?? null,
    visibleProjects(projects).some(project => project.path === persisted.directory))
}

/** Tests only. */
export function resetGoneSessionNotices(): void { told.clear() }
