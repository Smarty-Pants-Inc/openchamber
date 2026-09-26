import { toast } from '@/components/ui'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { useNotificationStore } from './notification-store'
import { takePendingSteer } from './pending-steers'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { getImperativeSessionMessageLoader } from './session-message-loader'

const OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'not-delivered', 'unconfirmed'])

/**
 * What finally became of a message the server steered into a running turn (co-steer, MVP 1 G5):
 * `smarty.prompt.outcome` {sessionID, messageID, outcome}, where messageID is the sending page's own.
 * 'delivered': the server's entry, with its author, replaces the page's copy; the record is simply settled.
 * 'not-delivered': the run ended without it and it is never sent again. 'unconfirmed': it may have landed changed,
 * bound to no entry. For both, only the tab that sent it holds its record (pending-steers): its copy goes, and its
 * sender is told, in the chat and a toast, with the text to send again. Other tabs hold no record and do nothing.
 */
export function applyPromptOutcome(properties: unknown, runtimeKey: string): void {
  const props = properties as { sessionID?: unknown; messageID?: unknown; outcome?: unknown } | null | undefined
  if (typeof props?.sessionID !== 'string' || typeof props.messageID !== 'string'
    || typeof props.outcome !== 'string' || !OUTCOMES.has(props.outcome)) return
  // An old runtime's stream can flush after a switch: its outcome is not this page's any more, and its loader is gone.
  if (runtimeKey !== getRuntimeKey()) return
  const loader = getImperativeSessionMessageLoader()
  const pending = takePendingSteer(runtimeKey, props.sessionID, props.messageID)
  if (!pending) return
  // Every effect below, and the deferred one, touches only this runtime's loader.
  const current = () => loader !== null && getImperativeSessionMessageLoader() === loader && getRuntimeKey() === runtimeKey
  if (props.outcome === 'delivered') {
    // The visible copy stays until the server's entry replaces it; its shadow must not outlive the delivery.
    queueMicrotask(() => { if (current()) loader!.optimisticConfirm(pending) })
    return
  }
  const key = props.outcome === 'not-delivered' ? 'chat.coSteer.notDelivered' : 'chat.coSteer.unconfirmed'
  const words = formatMessage(useI18nStore.getState().dictionary, key, { text: pending.text })
  useNotificationStore.getState().append({ type: 'error', session: pending.sessionID, directory: pending.directory,
    time: Date.now(), viewed: true, error: { name: null, message: words } })
  toast.error(words)
  // After the current event batch publishes: a batch that already copied the store would otherwise restore it.
  queueMicrotask(() => { if (current()) loader!.optimisticRemove(pending) })
}
