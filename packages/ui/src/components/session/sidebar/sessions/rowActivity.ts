import type { HerdrState } from '@/lib/herdrSession';

type RowActivityInput = {
  herdrState: HerdrState | undefined;
  isStreaming: boolean;
  needsAttention: boolean;
  isActive: boolean;
  isMovingToWorktree: boolean;
  hasActivityDuration: boolean;
  /** The fleet status read lists this row's project unknown (smarty-code#539). */
  statusUnavailable?: boolean;
};

/**
 * What a sidebar row shows about its activity. A Smarty Code row carries Herdr's own state, so it shows only that
 * state, in Herdr's words, as Herdr does: no separate unread marker and no activity timer (smarty-code#126 (c)5, F4).
 * A stock row keeps OpenChamber's running/unread marker and timer. A row without a Herdr state whose project's status
 * is unknown says so instead of a running or unread marker; Herdr's own state always wins.
 */
export function rowActivity(input: RowActivityInput) {
  const { herdrState, isStreaming, needsAttention, isActive, isMovingToWorktree, hasActivityDuration } = input;
  const showStatusUnavailable = !herdrState && input.statusUnavailable === true;
  const showUnreadStatus = !herdrState && !showStatusUnavailable && !isMovingToWorktree && !isStreaming && needsAttention && !isActive;
  return {
    showUnreadStatus,
    showStatusUnavailable,
    showStatusMarker: isStreaming || showUnreadStatus || showStatusUnavailable || herdrState !== undefined,
    showActivityDuration: !herdrState && !showStatusUnavailable && (isStreaming || showUnreadStatus) && hasActivityDuration,
  };
}
