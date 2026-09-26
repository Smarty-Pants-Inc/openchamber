/**
 * Context-window usage for a specific session, against the window of the model that session runs.
 *
 * `useSessionUIStore.getContextUsage` cannot serve this panel. It reads
 * `getSyncMessages(sessionId)` with **no directory**, which resolves to the
 * *current* directory's child store, and it keys off the store's own
 * `currentSessionId`. A session held by another directory — a worktree, or any
 * moment right after a directory switch — therefore reads as "no messages" and
 * the readout silently disappears while the header still shows a value.
 *
 * This computes the same quantity from messages the caller has already
 * subscribed to for a known session and directory, so there is no hidden
 * global read to race with.
 */

import { contextTokensFromBreakdown } from '@/stores/utils/tokenUtils';

type MessageTokens = {
  /** Server-reported window of the turn's final round-trip; absent on older servers. */
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type MessageLike = {
  id?: string;
  role?: string;
  tokens?: MessageTokens;
  providerID?: string;
  modelID?: string;
};

type ModelRef = { providerID: string; modelID: string };
type ProviderLike = { id: string; models: ReadonlyArray<{ id: string; limit?: unknown }> };

type WorkStatusContextUsage = {
  totalTokens: number;
  /** The session model's context window; 0 when it reports none. */
  limit: number;
  /** Unrounded, so the panel and the header cannot disagree by a rounding step; null without a known window. */
  percent: number | null;
};

const windowOf = (providers: readonly ProviderLike[], ref: ModelRef | null): { context: number; output: number } => {
  const model = ref ? providers.find((provider) => provider.id === ref.providerID)?.models.find((candidate) => candidate.id === ref.modelID) : undefined;
  const limit = model?.limit as { context?: unknown; output?: unknown } | undefined;
  const positive = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);
  return { context: positive(limit?.context), output: positive(limit?.output) };
};

/**
 * The model this session runs, in order of authority: the ordinary session's native model, else the model of its
 * newest reply, else the composer's selection (which follows the person's last pick, possibly in another session).
 */
export const sessionModelRef = (
  sessionModel: ModelRef | 'unavailable' | null | undefined,
  messages: readonly MessageLike[],
  selectedModel: ModelRef | null | undefined,
): ModelRef | null => {
  // An ordinary session whose native model is unavailable has no current window: no history or selection stands in.
  if (sessionModel === 'unavailable') return null;
  if (sessionModel) return sessionModel;
  const replied = [...messages].reverse().find((message) => message.role === 'assistant' && message.providerID && message.modelID);
  if (replied) return { providerID: replied.providerID!, modelID: replied.modelID! };
  return selectedModel ?? null;
};

/**
 * The context window of the model this session runs, and only that model: 0 when that model reports none, never
 * another model's window (smarty-dev#777 G14).
 */
export const sessionContextWindow = (
  providers: readonly ProviderLike[],
  sessionModel: ModelRef | 'unavailable' | null | undefined,
  messages: readonly MessageLike[],
  selectedModel: ModelRef | null | undefined,
): { context: number; output: number } => windowOf(providers, sessionModelRef(sessionModel, messages, selectedModel));

/**
 * Usage from the newest assistant message that reported a non-zero token count.
 * The latest turn describes the current fill — not a sum across turns. Within
 * a turn, the server-reported `total` is the final round-trip's window;
 * summing the breakdown fields instead overstates multi-step turns, whose
 * input/cache fields accumulate across round-trips.
 */
export const computeContextUsage = (
  messages: readonly MessageLike[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  if (messages.length === 0) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.tokens) continue;

    const totalTokens = contextTokensFromBreakdown(message.tokens);
    if (totalTokens <= 0) continue;

    // No known window means no percentage: dividing by a guessed window showed a 1M-token session at "186.1%" (G14).
    const limit = contextLimit > 0 ? contextLimit : 0;
    return { totalTokens, limit, percent: limit ? (totalTokens / limit) * 100 : null };
  }

  return null;
};

/**
 * Whether the header shows its context meter: tokens are in use and the session model's window is known right now.
 * A retained reading from when the window was known does not count once it is unknown (G14).
 */
export const showsHeaderContextMeter = (options: {
  isVSCode: boolean;
  workStatusPanelVisible: boolean;
  retainedTokens: number | null | undefined;
  contextLimit: number;
}): boolean => !options.isVSCode && !options.workStatusPanelVisible
  && (options.retainedTokens ?? 0) > 0 && options.contextLimit > 0;
