import { create } from 'zustand'

/**
 * This page's own prompt calls (`prompt_async`) per session, while they are pending, and when the last one answered.
 * On a loaded host a busy owner can take 15-18 s to take a prompt; until the call answers, nothing says the reply did
 * not start (smarty-code#902). ponytail: a count per session id, in memory; a reload has no pending call.
 */
type State = { pending: Readonly<Record<string, number>>; answeredAt: Readonly<Record<string, number>> }
export const usePromptsInFlight = create<State>(() => ({ pending: {}, answeredAt: {} }))

export async function trackPrompt<T>(sessionId: string, call: () => Promise<T>): Promise<T> {
  const change = (by: number) => usePromptsInFlight.setState((state) => ({
    pending: { ...state.pending, [sessionId]: (state.pending[sessionId] ?? 0) + by },
    answeredAt: by < 0 ? { ...state.answeredAt, [sessionId]: Date.now() } : state.answeredAt,
  }))
  change(1)
  try { return await call() } finally { change(-1) }
}
