import type { HerdrState } from '@/lib/herdrSession';

type RowActivityInput = {
  herdrState: HerdrState | undefined;
  isStreaming: boolean;
  needsAttention: boolean;
  isActive: boolean;
  isMovingToWorktree: boolean;
  hasActivityDuration: boolean;
};

/**
 * What a sidebar row shows about its activity. A Smarty Code row carries Herdr's own state, so it shows only that
 * state, in Herdr's words, as Herdr does: no separate unread marker and no activity timer (smarty-code#126 (c)5, F4).
 * A stock row keeps OpenChamber's running/unread marker and timer.
 */
export function rowActivity(input: RowActivityInput) {
  const { herdrState, isStreaming, needsAttention, isActive, isMovingToWorktree, hasActivityDuration } = input;
  const showUnreadStatus = !herdrState && !isMovingToWorktree && !isStreaming && needsAttention && !isActive;
  return {
    showUnreadStatus,
    showStatusMarker: isStreaming || showUnreadStatus || herdrState !== undefined,
    showActivityDuration: !herdrState && (isStreaming || showUnreadStatus) && hasActivityDuration,
  };
}
