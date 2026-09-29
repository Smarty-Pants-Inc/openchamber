import { windowFor } from '@/sync/position-windows';
import type { GapEntry } from './turns/renderEntries';

/** Records read per window (the range read's target size, smarty-code#583). */
export const WINDOW_RECORDS = 200;

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

