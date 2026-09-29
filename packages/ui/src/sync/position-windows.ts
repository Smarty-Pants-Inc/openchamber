/**
 * smarty-code#583 (Paul, 20:42Z): a session of any size is one list the length of the whole session; the page loads the
 * windows of records the reader looks at, by position. This module is the pure bookkeeping: which record ranges are
 * loaded, the gaps between them, and which window to read for a gap the reader has reached.
 *
 * Positions index the selected branch's display records (0 = the first), as the gateway's range read serves them.
 * They never shift while the index epoch is unchanged (appends only grow the end); a new epoch drops every window.
 */
export type Range = { start: number; end: number } // [start, end)
export type Gap = Range & { key: string }

/** Adds [start, end) to sorted, disjoint `ranges`, merging touching or overlapping ones. */
export function addRange(ranges: readonly Range[], added: Range): Range[] {
    if (added.end <= added.start) return [...ranges];
    const out: Range[] = [];
    let merged = { ...added };
    for (const range of ranges) {
        if (range.end < merged.start) out.push(range);
        else if (range.start > merged.end) out.push(range);
        else merged = { start: Math.min(range.start, merged.start), end: Math.max(range.end, merged.end) };
    }
    out.push(merged);
    return out.sort((a, b) => a.start - b.start);
}

/** The unloaded ranges of [0, total): before, between and after the loaded ranges. Keys name their start position. */
export function gapsOf(ranges: readonly Range[], total: number): Gap[] {
    const gaps: Gap[] = [];
    let at = 0;
    for (const range of ranges) {
        if (range.start > at) gaps.push({ start: at, end: Math.min(range.start, total), key: `gap:${at}` });
        at = Math.max(at, range.end);
    }
    if (at < total) gaps.push({ start: at, end: total, key: `gap:${at}` });
    return gaps.filter((gap) => gap.end > gap.start);
}

/**
 * The window to read for a gap the reader has reached, `limit` records long, clamped to the gap:
 * - `edge: 'end'` (scrolling up into it from below): its last `limit` records, next to what is shown;
 * - `edge: 'start'` (scrolling down into it from above): its first `limit` records;
 * - `fraction` (landed inside it: a jump or a scrollbar drag): centred on that point.
 */
export function windowFor(gap: Range, limit: number, target: { edge: 'start' | 'end' } | { fraction: number }): Range {
    const size = Math.max(1, limit);
    if ('edge' in target) {
        return target.edge === 'end'
            ? { start: Math.max(gap.start, gap.end - size), end: gap.end }
            : { start: gap.start, end: Math.min(gap.end, gap.start + size) };
    }
    const point = gap.start + Math.floor(Math.min(1, Math.max(0, target.fraction)) * (gap.end - gap.start));
    const start = Math.max(gap.start, Math.min(point - Math.floor(size / 2), gap.end - size));
    return { start, end: Math.min(gap.end, start + size) };
}

/** A placeholder's estimated height: its record count times the average height of the records measured so far. */
export function gapHeight(gap: Range, averageRecordPx: number): number {
    return Math.max(1, Math.round((gap.end - gap.start) * Math.max(8, averageRecordPx)));
}
