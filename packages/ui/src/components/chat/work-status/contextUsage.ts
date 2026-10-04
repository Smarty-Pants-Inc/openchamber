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

import { findLatestContextFill, type ContextFillMessage } from '@/stores/utils/tokenUtils';

type MessageLike = ContextFillMessage & { providerID?: string; modelID?: string };
type ModelRef = { providerID: string; modelID: string };
type ProviderLike = { id: string; models: ReadonlyArray<{ id: string; limit?: { context?: number; output?: number } }> };

type WorkStatusContextUsage =
  | {
    state: 'measured';
    totalTokens: number;
    /** The session model's context window; 0 when it reports none. */
    limit: number;
    /** Unrounded, so the panel and the header cannot disagree; null without a known window. */
    percent: number | null;
  }
  /** Compacted since the last response that reported tokens: the fill is unknown, not zero. */
  | { state: 'compacted'; limit: number };

const windowOf = (providers: readonly ProviderLike[], ref: ModelRef | null): { context: number; output: number } => {
  const model = ref ? providers.find((provider) => provider.id === ref.providerID)?.models.find((candidate) => candidate.id === ref.modelID) : undefined;
  const limit = model?.limit;
  const positive = (value: number | undefined) => (value !== undefined && value > 0 ? value : 0);
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
 * Usage from the newest assistant message that reported a non-zero token count,
 * or `compacted` when a finished compaction is newer than any such message
 * (see `findLatestContextFill`). The latest turn describes the current fill —
 * not a sum across turns. Within a turn, the server-reported `total` is the
 * final round-trip's window; summing the breakdown fields instead overstates
 * multi-step turns, whose input/cache fields accumulate across round-trips.
 */
export const computeContextUsage = (
  messages: readonly ContextFillMessage[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;

  // No known window means no percentage: a guessed window misreported native sessions (G14).
  const limit = contextLimit > 0 ? contextLimit : 0;
  if (fill.state === 'compacted') return { state: 'compacted', limit };
  return { state: 'measured', totalTokens: fill.totalTokens, limit, percent: limit ? (fill.totalTokens / limit) * 100 : null };
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
