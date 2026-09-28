// An older page's rows keep re-measuring for about a second after it lands, and the list can remount the reader's row
// meanwhile, so the prepend hold waits longer to settle and brings a remounted anchor back (smarty-code#583).
export type AnchorHoldOptions = { stableFrames?: number; maxFrames?: number; restoreMissing?: boolean };
export const PREPEND_ANCHOR_HOLD: AnchorHoldOptions = { stableFrames: 90, maxFrames: 360, restoreMissing: true };

import { SCROLL_INTENT_EVENT, SCROLL_NAVIGATE_EVENT } from '@/lib/scrollIntent';

/**
 * Every input that means the reader is moving the view themselves: any of these ends a hold (review/astra OC#334).
 * The overlay scrollbar's thumb is outside the container, so its drag arrives as SCROLL_INTENT_EVENT.
 */
export const READER_INTENT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown', SCROLL_INTENT_EVENT] as const;
/** READER_INTENT_EVENTS plus an explicit navigation ("return to latest"): all of them end a hold. */
const HOLD_END_EVENTS = [...READER_INTENT_EVENTS, SCROLL_NAVIGATE_EVENT] as const;

export type AnchorHoldTarget = {
    container: Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'getBoundingClientRect' | 'scrollTop'>;
    /** The anchor's element as the list renders it NOW, or null while it is unmounted. */
    findElement: (messageId: string) => Pick<HTMLElement, 'getBoundingClientRect'> | null;
    /** Brings the anchor's row back into range using the list's CURRENT message-to-row mapping; false if unknown. */
    scrollAnchorRowIntoView: (messageId: string) => boolean;
    requestFrame: (step: () => void) => void;
};

/**
 * Holds `anchor.messageId` at `anchor.offsetTop` until it is steady for `stableFrames` or `maxFrames` pass. It measures
 * the element each frame and applies only the remaining difference, so a list that already kept the place gets no
 * write. Any reader input ends it; the returned function ends it too (explicit navigation, a newer hold).
 */
export function runAnchorHold(target: AnchorHoldTarget, anchor: { messageId: string; offsetTop: number },
    options: AnchorHoldOptions = {}, defaults: { stableFrames: number; maxFrames: number }): () => void {
    const stableFrames = options.stableFrames ?? defaults.stableFrames;
    const maxFrames = options.maxFrames ?? defaults.maxFrames;
    const { container } = target;
    let frames = 0, stable = 0, done = false;
    const stop = () => {
        if (done) return;
        done = true;
        for (const name of HOLD_END_EVENTS) container.removeEventListener(name, stop);
    };
    for (const name of HOLD_END_EVENTS) container.addEventListener(name, stop, { passive: true });
    const step = () => {
        if (done) return;
        const element = target.findElement(anchor.messageId);
        if (element) {
            const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offsetTop;
            if (Math.abs(delta) > 0.5) {
                container.scrollTop += delta;
                stable = 0;
            } else {
                stable += 1;
            }
        } else if (options.restoreMissing && target.scrollAnchorRowIntoView(anchor.messageId)) {
            stable = 0;
        }
        frames += 1;
        if (stable >= stableFrames || frames >= maxFrames) { stop(); return; }
        target.requestFrame(step);
    };
    target.requestFrame(step);
    return stop;
}
