/**
 * Messages this tab sent into a running ordinary turn that the server has queued but not yet settled (co-steer,
 * MVP 1 G5). The final outcome arrives later as `smarty.prompt.outcome`, maybe after a reload or after the transcript
 * cache dropped the page's copy, so the sender and the text are kept here, per tab (sessionStorage) and per runtime.
 * A record is added before dispatch, kept only when the server says it queued a steer, and removed by the outcome.
 */
export type PendingSteer = {
  runtimeKey: string
  directory: string
  sessionID: string
  messageID: string
  text: string
  at: number
}

const STORAGE_KEY = 'smarty-code.pending-steers.v1'
// ponytail: an outcome normally arrives within one agent turn; a day and 50 records bound what a lost event can leave.
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_RECORDS = 50

const storage = (): Storage | undefined => {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage } catch { return undefined }
}

const read = (): PendingSteer[] => {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]')
    const now = Date.now()
    return Array.isArray(parsed) ? parsed.filter((item): item is PendingSteer => Boolean(item)
      && typeof item.runtimeKey === 'string' && typeof item.directory === 'string' && typeof item.sessionID === 'string'
      && typeof item.messageID === 'string' && typeof item.text === 'string' && typeof item.at === 'number'
      && now - item.at < MAX_AGE_MS) : []
  } catch { return [] }
}

// The in-memory list is authoritative for this page; storage only carries it across a reload, so a full or blocked
// sessionStorage never stops a live outcome from reaching its sender.
let records: PendingSteer[] | undefined
const all = (): PendingSteer[] => (records ??= read())
const write = (items: PendingSteer[]) => {
  records = items.slice(-MAX_RECORDS)
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(records)) } catch { /* full or blocked: best effort */ }
}

const same = (item: PendingSteer, runtimeKey: string, sessionID: string, messageID: string) =>
  item.runtimeKey === runtimeKey && item.sessionID === sessionID && item.messageID === messageID

/**
 * Adds the record and returns true, or returns false when that message is already pending from an earlier send: then
 * this send does not own it and must not settle it (a refused resend must not erase the queued original).
 */
export function registerPendingSteer(record: Omit<PendingSteer, 'at'>): boolean {
  const items = all()
  if (items.some(item => same(item, record.runtimeKey, record.sessionID, record.messageID))) return false
  write([...items, { ...record, at: Date.now() }])
  return true
}

export function hasPendingSteer(runtimeKey: string, sessionID: string, messageID: string): boolean {
  return all().some(item => same(item, runtimeKey, sessionID, messageID))
}

/** Removes the record and returns it: the outcome settled it, or the send turned out not to be a queued steer. */
export function takePendingSteer(runtimeKey: string, sessionID: string, messageID: string): PendingSteer | undefined {
  const items = all()
  const found = items.find(item => same(item, runtimeKey, sessionID, messageID))
  if (found) write(items.filter(item => item !== found))
  return found
}

/** Test seam: forget the in-memory list so the next read comes from storage, as after a reload. */
export function reloadPendingSteersForTest(): void { records = undefined }
