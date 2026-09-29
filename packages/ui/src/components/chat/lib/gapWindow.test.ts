import { expect, test } from 'bun:test';
import { gapWindow, gapWindows } from '../lib/gapWindow';

// A gap 1,000..5,000 drawn as chunks of 100 records; the view is 0..800 px.
const chunk = (start: number) => ({ kind: 'gap' as const, key: `gap:${start}`, start, end: start + 100, gapStart: 1_000, gapEnd: 5_000, heightPx: 8_000 });
const view = { top: 0, bottom: 800 };

// Candidate (#363 round 2 evidence): each read covered one 100-record chunk and started only when that chunk showed, so
// continuous scrolling (~2,800 px/s) outran the reads and the reader saw placeholders.
test('scrolling up to a chunk above: 500 records ending at its end, reaching past the chunk into the gap', () => {
    expect(gapWindow(chunk(3_000), { top: -8_500, bottom: -500 }, view)).toEqual({ start: 2_600, end: 3_100 });
});

test('scrolling down to a chunk below: 500 records from its start', () => {
    expect(gapWindow(chunk(3_000), { top: 1_200, bottom: 9_200 }, view)).toEqual({ start: 3_000, end: 3_500 });
});

test('a jump into the middle of a chunk: the window around the view', () => {
    expect(gapWindow(chunk(3_000), { top: -4_000, bottom: 4_000 }, view)).toEqual({ start: 2_805, end: 3_305 });
});

test('scrolling up, a request reads the window reached first, then the one before it', () => {
    expect(gapWindows(chunk(3_000), { top: -8_500, bottom: -500 }, view)).toEqual([{ start: 2_600, limit: 500 }, { start: 2_100, limit: 500 }]);
});

test('scrolling down, the window reached first, then the one after it; a jump reads only where it landed', () => {
    expect(gapWindows(chunk(3_000), { top: 1_200, bottom: 9_200 }, view)).toEqual([{ start: 3_000, limit: 500 }, { start: 3_500, limit: 500 }]);
    expect(gapWindows(chunk(3_000), { top: -4_000, bottom: 4_000 }, view)).toHaveLength(1);
});

test('the read-ahead stays within the gap', () => {
    expect(gapWindows(chunk(1_000), { top: -8_500, bottom: -500 }, view)).toEqual([{ start: 1_000, limit: 100 }]);
});
