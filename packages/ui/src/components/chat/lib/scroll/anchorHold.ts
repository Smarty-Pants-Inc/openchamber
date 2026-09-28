// An older page's rows keep re-measuring for about a second after it lands, and the list can remount the reader's row
// meanwhile, so the prepend hold waits longer to settle and brings a remounted anchor back (smarty-code#583).
export type AnchorHoldOptions = { stableFrames?: number; maxFrames?: number; restoreMissing?: boolean };
export const PREPEND_ANCHOR_HOLD: AnchorHoldOptions = { stableFrames: 90, maxFrames: 360, restoreMissing: true };
