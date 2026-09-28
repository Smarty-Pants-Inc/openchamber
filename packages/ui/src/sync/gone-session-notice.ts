import { toast } from '@/components/ui/toast'
import { reportClientError } from '@/lib/clientErrorReport'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { opencodeClient } from '@/lib/opencode/client'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { gatewayRecoveryMessage } from './session-message-loader'

/**
 * smarty-code#775 (folds #761): the page used to drop a session that is no longer available (its Pi ended, or its
 * worktree left the catalog) and land on an empty draft without a word. Say so once, in the gateway's own words when it
 * answers 404 with them (smarty-code#758), else in the same words from the dictionary. The draft stays usable.
 * ponytail: a toast, not a new layout slot; it is the first sign, and the draft underneath is the person's next step.
 */
const told = new Set<string>()

type Read = (sessionId: string, directory: string) => Promise<{ status?: number; error?: unknown }>
const readSession: Read = async (sessionId, directory) => {
  const result = await opencodeClient.getScopedSdkClient(directory).session.get({ sessionID: sessionId })
  return { status: result.response?.status, error: result.error }
}

/** `listed`: the session's directory is still a live project (then its own read decides: only a 404 is "gone"). */
export async function noteGoneSession(sessionId: string, directory: string | null, listed: boolean, read: Read = readSession): Promise<boolean> {
  const runtimeKey = getRuntimeKey(), key = JSON.stringify([runtimeKey, sessionId])
  if (told.has(key)) return false
  told.add(key)
  let words: string | null = null
  if (listed && directory) {
    const answer = await read(sessionId, directory).catch(() => null)
    // Only the gateway's definite 404 says gone; a failed or other read says nothing (it may be back in a moment).
    if (answer?.status !== 404) { told.delete(key); return false }
    words = gatewayRecoveryMessage(answer.error)
  }
  if (getRuntimeKey() !== runtimeKey) { told.delete(key); return false }
  toast.warning(words ?? formatMessage(useI18nStore.getState().dictionary, 'chat.container.sessionGone', {}), { duration: 15_000 })
  reportClientError({ kind: 'session.gone', sessionID: sessionId, runtimeKey, operationId: sessionId })
  return true
}

/** Tests only. */
export function resetGoneSessionNotices(): void { told.clear() }
