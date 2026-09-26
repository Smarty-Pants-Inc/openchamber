import { create } from 'zustand'

/**
 * Steered messages the server settled as not sent (co-steer, MVP 1 G5): each stays in its session's chat, with its text,
 * until its sender dismisses it. Unlike the failed-turn notice, it does not depend on the session being idle, on newer
 * messages or on other errors, and every one is kept. Per tab (sessionStorage, best effort) and per runtime.
 */
export type SettledSteer = {
  runtimeKey: string
  sessionID: string
  messageID: string
  outcome: 'not-delivered' | 'unconfirmed'
  text: string
  at: number
}

const STORAGE_KEY = 'smarty-code.steer-outcomes.v1'
// ponytail: a day and 50 notices bound what an unread chat can accumulate.
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ITEMS = 50

const storage = (): Storage | undefined => {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage } catch { return undefined }
}
const read = (): SettledSteer[] => {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]')
    const now = Date.now()
    return Array.isArray(parsed) ? parsed.filter((item): item is SettledSteer => Boolean(item)
      && typeof item.runtimeKey === 'string' && typeof item.sessionID === 'string' && typeof item.messageID === 'string'
      && (item.outcome === 'not-delivered' || item.outcome === 'unconfirmed') && typeof item.text === 'string'
      && typeof item.at === 'number' && now - item.at < MAX_AGE_MS) : []
  } catch { return [] }
}
const persist = (items: SettledSteer[]) => {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(items)) } catch { /* full or blocked: best effort */ }
  return items
}
const same = (item: SettledSteer, runtimeKey: string, messageID: string) => item.runtimeKey === runtimeKey && item.messageID === messageID

type SteerOutcomeState = {
  items: SettledSteer[]
  add: (item: SettledSteer) => void
  dismiss: (runtimeKey: string, messageID: string) => void
}

export const useSteerOutcomes = create<SteerOutcomeState>()((set) => ({
  items: read(),
  add: (item) => set(state => ({
    items: persist([...state.items.filter(existing => !same(existing, item.runtimeKey, item.messageID)), item].slice(-MAX_ITEMS)),
  })),
  dismiss: (runtimeKey, messageID) => set(state => ({
    items: persist(state.items.filter(existing => !same(existing, runtimeKey, messageID))),
  })),
}))

/** Test seam: read the list again from storage, as after a reload. */
export function reloadSteerOutcomesForTest(): void { useSteerOutcomes.setState({ items: read() }) }
