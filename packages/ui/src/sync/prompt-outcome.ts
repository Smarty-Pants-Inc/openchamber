import { toast } from '@/components/ui'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { useSteerOutcomes } from './steer-outcomes'
import { takePendingSteer } from './pending-steers'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { getImperativeSessionMessageLoader } from './session-message-loader'

const OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'not-delivered', 'unconfirmed'])

// Messages this tab was told had failed, kept apart from their notices (which the person may dismiss), so a later
// 'delivered' correction can still restore the message. Delivered is final, so a correction ends the record.
// ponytail: in memory and bounded; a correction after a reload finds the notice record (sessionStorage) instead.
type FailedSteer = { directory?: string; outcome: 'not-delivered' | 'unconfirmed' }
const failed = new Map<string, FailedSteer>()
const failedKey = (runtimeKey: string, sessionID: string, messageID: string) => `${runtimeKey}\n${sessionID}\n${messageID}`
const remember = (key: string, value: FailedSteer) => {
  failed.delete(key); failed.set(key, value)
  if (failed.size > 200) failed.delete(failed.keys().next().value!)
}

/**
 * What finally became of a message the server steered into a running turn (co-steer, MVP 1 G5):
 * `smarty.prompt.outcome` {sessionID, messageID, outcome}, where messageID is the sending page's own.
 * 'delivered': the server's entry, with its author, replaces the page's copy; the record is simply settled.
 * 'not-delivered': the run ended without it and it is never sent again. 'unconfirmed': it may have landed changed,
 * bound to no entry. For both, only the tab that sent it holds its record (pending-steers): its copy goes, and its
 * sender is told, in the chat and a toast, with the text to send again. Other tabs hold no record and do nothing.
 * A later corrected outcome for the same message updates that notice: 'delivered' clears it.
 */
export function applyPromptOutcome(properties: unknown, runtimeKey: string): void {
  const props = properties as { sessionID?: unknown; messageID?: unknown; outcome?: unknown } | null | undefined
  if (typeof props?.sessionID !== 'string' || typeof props.messageID !== 'string'
    || typeof props.outcome !== 'string' || !OUTCOMES.has(props.outcome)) return
  // An old runtime's stream can flush after a switch: its outcome is not this page's any more, and its loader is gone.
  if (runtimeKey !== getRuntimeKey()) return
  const loader = getImperativeSessionMessageLoader()
  const pending = takePendingSteer(runtimeKey, props.sessionID, props.messageID)
  if (!pending) {
    // The gateway may correct an outcome it already sent (same sessionID and messageID). Only the sender's chat holds a
    // notice for it: a later 'delivered' clears that notice, and a different failure replaces its wording.
    const notices = useSteerOutcomes.getState()
    const shown = notices.items.find((item) => item.runtimeKey === runtimeKey && item.sessionID === props.sessionID
      && item.messageID === props.messageID)
    const key = failedKey(runtimeKey, props.sessionID, props.messageID)
    const earlier = failed.get(key) ?? (shown ? { directory: shown.directory, outcome: shown.outcome } : undefined)
    if (!earlier || earlier.outcome === props.outcome) return
    if (props.outcome !== 'delivered') {
      remember(key, { ...earlier, outcome: props.outcome as 'not-delivered' | 'unconfirmed' })
      if (shown) notices.add({ ...shown, outcome: props.outcome as 'not-delivered' | 'unconfirmed', at: Date.now() })
      return
    }
    failed.delete(key)
    if (shown) notices.dismiss(runtimeKey, shown.messageID)
    // The message did arrive: retire the page's shadow (so a later authoritative removal stays removed), and read the
    // session's tail again so the message shows where the failure removed the copy. Delivered is final.
    if (loader && earlier.directory) {
      const target = { directory: earlier.directory, sessionID: props.sessionID, messageID: props.messageID }
      queueMicrotask(() => { if (getImperativeSessionMessageLoader() === loader) loader.optimisticConfirm(target) })
      void loader.refreshTail({ directory: earlier.directory, sessionID: props.sessionID }, 50).catch(() => {})
    }
    return
  }
  // Every effect below, and the deferred one, touches only this runtime's loader.
  const current = () => loader !== null && getImperativeSessionMessageLoader() === loader && getRuntimeKey() === runtimeKey
  if (props.outcome === 'delivered') {
    // The visible copy stays until the server's entry replaces it; its shadow must not outlive the delivery.
    queueMicrotask(() => { if (current()) loader!.optimisticConfirm(pending) })
    return
  }
  const key = props.outcome === 'not-delivered' ? 'chat.coSteer.notDelivered' : 'chat.coSteer.unconfirmed'
  const words = formatMessage(useI18nStore.getState().dictionary, key, { text: pending.text })
  // It stays in the chat, with its text, until its sender dismisses it; the toast is only the first sign.
  remember(failedKey(runtimeKey, pending.sessionID, pending.messageID),
    { directory: pending.directory, outcome: props.outcome as 'not-delivered' | 'unconfirmed' })
  useSteerOutcomes.getState().add({ runtimeKey, sessionID: pending.sessionID, directory: pending.directory, messageID: pending.messageID,
    outcome: props.outcome as 'not-delivered' | 'unconfirmed', text: pending.text, at: Date.now() })
  toast.error(words)
  // After the current event batch publishes: a batch that already copied the store would otherwise restore it. Not if a
  // correction in the same batch already said it was delivered (its notice is gone): then the message stays.
  queueMicrotask(() => {
    const stillFailed = failed.has(failedKey(runtimeKey, pending.sessionID, pending.messageID))
    if (current() && stillFailed) loader!.optimisticRemove(pending)
  })
}
