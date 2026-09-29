import { create } from 'zustand'

/**
 * This page's own prompt calls (`prompt_async`) per session: how many are pending, when the last one answered, and the
 * gateway's receipt for it (`x-smarty-prompt-receipt`: accepted = it started a run; queued = Pi holds it until a turn
 * boundary or the run's end). On a loaded host a busy owner takes 15-18 s to answer, and a queued prompt starts its
 * reply only later: neither is a reply that "did not start" (smarty-code#902). ponytail: in memory; a reload has none.
 */
export type PromptReceipt = 'accepted' | 'queued'
type State = {
  pending: Readonly<Record<string, number>>
  answeredAt: Readonly<Record<string, number>>
  receipt: Readonly<Record<string, PromptReceipt | undefined>>
}
export const usePromptsInFlight = create<State>(() => ({ pending: {}, answeredAt: {}, receipt: {} }))

const receiptOf = (response: Response | undefined): PromptReceipt | undefined => {
  const value = response?.ok ? response.headers.get('x-smarty-prompt-receipt') : null
  return value === 'accepted' || value === 'queued' ? value : undefined
}

export async function trackPrompt<T extends { response: Response }>(sessionId: string, call: () => Promise<T>): Promise<T> {
  const change = (by: number, receipt?: PromptReceipt) => usePromptsInFlight.setState((state) => ({
    pending: { ...state.pending, [sessionId]: (state.pending[sessionId] ?? 0) + by },
    ...(by < 0 ? { answeredAt: { ...state.answeredAt, [sessionId]: Date.now() }, receipt: { ...state.receipt, [sessionId]: receipt } } : {}),
  }))
  change(1)
  let result: T | undefined
  try { result = await call(); return result } finally { change(-1, receiptOf(result?.response)) }
}
