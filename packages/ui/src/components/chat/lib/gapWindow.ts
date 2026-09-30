import { windowFor } from '@/sync/position-windows';
import type { GapEntry } from './turns/renderEntries';
import type { Window } from './windowQueue';

/**
 * Records read per window (smarty-code#583): the range read's maximum. Continuous wheel scrolling crosses ~2,800 px/s
 * (~35 records a second at ~80 px); with 200-record windows read one at a time the reader reached a placeholder about
 * every 7 s on the candidate (5-6 steps in 40 s). A 500-record window is ~40,000 px, more than 10 s of scrolling.
 */
export const WINDOW_RECORDS = 500;
/**
 * Windows read per request (smarty-code#583): the one the reader reaches, then the next one past it, so the next read
 * starts a whole window (~40,000 px) before the reader gets there. With one window a request started only when the list
 * mounted the next placeholder, ~1,800 px ahead: under a second at wheel speed (candidate 04:23Z).
 */
export const READ_AHEAD_WINDOWS = 2;
/** During a continuous scroll through a placeholder, how often the window at the reader's place is read (#583). */
export const GAP_SCROLL_READ_MS = 250;
/** How long a placeholder stays near the view before its windows are read (a drag passes many). */
export const GAP_SETTLE_MS = 90;
/** How far ahead of the view the list mounts rows, placeholders included (LegendList drawDistance). The next window is
 *  read a whole window ahead (READ_AHEAD_WINDOWS), so this no longer carries the read-ahead: 1,800 px mounted rows the
 *  reader had not reached and kept the main thread 50-65 % busy in continuous scrolling (candidate 15:0xZ). */
export const TIMELINE_DRAW_DISTANCE = 600;

/**
 * smarty-code#583: the window a gap chunk reads, within its whole gap and toward the reader, so each read runs ahead of
 * the view: a chunk above the view (the reader scrolling up to it) reads the records that end at its end; below, the
 * records that start at its start; a chunk across the view reads around the view's middle (a jump or a drag).
 */
export function gapWindow(gap: GapEntry, box: { top: number; bottom: number }, view: { top: number; bottom: number }) {
    const whole = { start: gap.gapStart, end: gap.gapEnd };
    if (box.bottom <= view.bottom) return windowFor({ start: whole.start, end: gap.end }, WINDOW_RECORDS, { edge: 'end' });
    if (box.top >= view.top) return windowFor({ start: gap.start, end: whole.end }, WINDOW_RECORDS, { edge: 'start' });
    const inChunk = ((view.top + view.bottom) / 2 - box.top) / Math.max(1, box.bottom - box.top);
    const point = gap.start + inChunk * (gap.end - gap.start);
    return windowFor(whole, WINDOW_RECORDS, { fraction: (point - whole.start) / Math.max(1, whole.end - whole.start) });
}


/**
 * The windows a placeholder asks for, in reading order (smarty-code#583): the one the reader reaches, then up to
 * READ_AHEAD_WINDOWS - 1 more past it in the same direction, within the gap. A jump reads only where it landed.
 */
export function gapWindows(gap: GapEntry, box: { top: number; bottom: number }, view: { top: number; bottom: number }): Window[] {
    const first = gapWindow(gap, box, view);
    const windows = [{ start: first.start, limit: first.end - first.start }];
    const up = box.bottom <= view.bottom, down = !up && box.top >= view.top;
    for (let k = 1, at = first; k < READ_AHEAD_WINDOWS && (up || down); k++) {
        at = up ? { start: Math.max(gap.gapStart, at.start - WINDOW_RECORDS), end: at.start }
            : { start: at.end, end: Math.min(gap.gapEnd, at.end + WINDOW_RECORDS) };
        if (at.end <= at.start) break;
        windows.push({ start: at.start, limit: at.end - at.start });
    }
    return windows;
}
