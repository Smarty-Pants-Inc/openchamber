// The branded toast, not the reporting one: this toast quotes the person's own message, so it is reported below
// without it (smarty-code#536).
import { toast } from '@/components/ui/toast'
import { reportClientError } from '@/lib/clientErrorReport'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { useSteerOutcomes } from './steer-outcomes'
import { takePendingSteer } from './pending-steers'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { getImperativeSessionMessageLoader, type SessionMessageLoader } from './session-message-loader'
import { isUnsaved, optimisticMessageRecords } from './unsaved'
import { sendUnconfirmed } from '@/lib/sendUnconfirmed'
import type { PendingSteer } from './pending-steers'

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
    // A correction ends any check of the transcript; the sender, told only "Sent, checking…" so far, now hears a failure.
    const stopCheck = checks.get(key)
    if (stopCheck) { stopCheck(); checks.delete(key) }
    if (props.outcome !== 'delivered') {
      remember(key, { ...earlier, outcome: props.outcome as 'not-delivered' | 'unconfirmed' })
      if (shown) notices.add({ ...shown, outcome: props.outcome as 'not-delivered' | 'unconfirmed', at: Date.now() })
      if (stopCheck && shown) toast.error(formatMessage(useI18nStore.getState().dictionary,
        props.outcome === 'not-delivered' ? 'chat.coSteer.notDelivered' : 'chat.coSteer.unconfirmed', { text: shown.text }))
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
  const outcome = props.outcome as 'not-delivered' | 'unconfirmed'
  remember(failedKey(runtimeKey, pending.sessionID, pending.messageID), { directory: pending.directory, outcome })
  if (outcome === 'unconfirmed' && loader?.messageStore(pending)) { checkTranscript(runtimeKey, pending, loader, current); return }
  fail(runtimeKey, pending, outcome, current, loader)
}

/** The sender is told it failed, in the chat and a toast, and the page's copy goes. */
function fail(runtimeKey: string, pending: PendingSteer, outcome: 'not-delivered' | 'unconfirmed', current: () => boolean,
  loader: SessionMessageLoader | null): void {
  const words = formatMessage(useI18nStore.getState().dictionary,
    outcome === 'not-delivered' ? 'chat.coSteer.notDelivered' : 'chat.coSteer.unconfirmed', { text: pending.text })
  // It stays in the chat, with its text, until its sender dismisses it; the toast is only the first sign.
  useSteerOutcomes.getState().add({ runtimeKey, sessionID: pending.sessionID, directory: pending.directory, messageID: pending.messageID,
    outcome, text: pending.text, at: Date.now() })
  toast.error(words)
  reportClientError({ kind: `steer.${outcome}`, sessionID: pending.sessionID, runtimeKey, operationId: pending.messageID }) // The outcome, never the text.
  removeCopy(pending, current, loader)
}

// After the current event batch publishes: a batch that already copied the store would otherwise restore it. Not if a
// correction in the same batch already said it was delivered (its record is gone): then the message stays.
function removeCopy(pending: PendingSteer, current: () => boolean, loader: SessionMessageLoader | null): void {
  queueMicrotask(() => {
    const stillFailed = failed.has(failedKey(getRuntimeKey(), pending.sessionID, pending.messageID))
    if (current() && stillFailed) loader!.optimisticRemove(pending)
  })
}

// smarty-code#1514: transcript checks in progress for 'unconfirmed' (the gateway's 'unknown'), by failedKey; each value stops one.
const checks = new Map<string, () => void>()

/** The server's own user message with exactly our text, sent at or after our send (never the page's own copy). */
function matchingMessage(loader: SessionMessageLoader, pending: PendingSteer) {
  const state = loader.messageStore(pending)?.getState()
  return state?.message[pending.sessionID]?.find(message => message.role === 'user' && message.id !== pending.messageID
    && !optimisticMessageRecords.has(message) && (message.time?.created ?? 0) >= pending.at
    && (state.part[message.id] ?? []).filter(part => part.type === 'text' && !(part as { synthetic?: boolean }).synthetic)
      .map(part => (part as { text: string }).text).join('') === pending.text)
}

/**
 * 'unconfirmed' says only that the gateway could not bind the message to an entry; Kate's message was often in the
 * transcript all the same (#1502). So the page reads the session's messages it already holds, on that store's own
 * updates (no polling): while a server message with exactly our text, sent at or after ours, is there it says
 * "Sent, checking…"; once that message is saved, "Sent". "Not confirmed" only when none appears within the send
 * confirm window (sendUnconfirmed.ms), when the one that appeared is dropped before it is saved, or when it is still
 * unsaved after a second window (never "checking" forever).
 */
function checkTranscript(runtimeKey: string, pending: PendingSteer, loader: SessionMessageLoader, current: () => boolean): void {
  const key = failedKey(runtimeKey, pending.sessionID, pending.messageID)
  const notice = (outcome: 'checking' | 'sent') => useSteerOutcomes.getState().add({ runtimeKey, sessionID: pending.sessionID,
    directory: pending.directory, messageID: pending.messageID, outcome, text: pending.text, at: Date.now() })
  let seen = false, windowOver = false, savedBy = false
  // An absolute expiry, not only the timers: a late timer (a background tab) never lets a save after it read as "Sent".
  const expiresAt = Date.now() + 2 * sendUnconfirmed.ms
  const stop = () => { unsubscribe?.(); clearTimeout(timer); clearTimeout(deadline); checks.delete(key) }
  const evaluate = () => {
    // The loader went: this check can't go on. A reconnect in the same runtime fails it through the loader now in place
    // (the copy in the shared store goes, the sender is told); after a runtime switch the notice only says not confirmed.
    if (!current()) {
      stop()
      const now = getImperativeSessionMessageLoader()
      if (now && getRuntimeKey() === runtimeKey && failed.has(key)) fail(runtimeKey, pending, 'unconfirmed', () => getImperativeSessionMessageLoader() === now, now)
      else useSteerOutcomes.getState().settleChecking(runtimeKey, pending.messageID)
      return
    }
    if (!failed.has(key)) { stop(); return }
    if (Date.now() >= expiresAt) savedBy = windowOver = true
    const match = matchingMessage(loader, pending)
    if (match) {
      if (!seen) removeCopy(pending, current, loader) // The server's message stands in for the page's copy.
      seen = true
      if (savedBy) { stop(); fail(runtimeKey, pending, 'unconfirmed', current, loader) } // Expired first: never "Sent" late.
      else if (!isUnsaved(match)) { stop(); notice('sent') }
      return
    }
    if (seen || windowOver) { stop(); fail(runtimeKey, pending, 'unconfirmed', current, loader) }
  }
  checks.get(key)?.()
  notice('checking')
  const timer = setTimeout(() => { windowOver = true; evaluate() }, sendUnconfirmed.ms)
  const deadline = setTimeout(() => { savedBy = true; evaluate() }, 2 * sendUnconfirmed.ms)
  const unsubscribe: (() => void) | undefined = loader.messageStore(pending)?.subscribe(evaluate)
  checks.set(key, stop)
  evaluate()
}

/** Test seam: stop every transcript check (their timers). */
export function stopPromptOutcomeChecksForTest(): void { for (const stop of [...checks.values()]) stop() }
