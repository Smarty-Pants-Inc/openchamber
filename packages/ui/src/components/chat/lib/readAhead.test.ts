import { expect, test } from 'bun:test';
import { GAP_SETTLE_MS, READ_AHEAD_WINDOWS, TIMELINE_DRAW_DISTANCE, WINDOW_RECORDS } from './gapWindow';

// smarty-code#583 rate check (code-lead, #583 slip retro): the read-ahead must outrun the fastest measured wheel, with
// margin, BEFORE any real-time slot. Measured on the candidate (#822, dev-lead's and code-lead's journals):
const FASTEST_WHEEL_PX_PER_S = 2_800;     // 400 px wheel steps at ~145 ms, the harness's continuous wheel
const P90_WINDOW_READ_MS = 470;           // window reads 76-467 ms (00:53Z and 03:31Z runs)
const RENDER_MS = 200;                    // commit + layout of a loaded window, generous
const MIN_RECORD_PX = 40;                 // conservative: the measured mean is ~77 px a record
const MARGIN = 2;

// From the moment a request starts until its first window is on screen.
const leadNeededPx = FASTEST_WHEEL_PX_PER_S * (GAP_SETTLE_MS + P90_WINDOW_READ_MS + RENDER_MS) / 1000 * MARGIN;

test('the next window is requested far enough ahead of the reader at the fastest wheel', () => {
    // The request that reads window k also reads window k+1: when the reader reaches the placeholder after window k+1,
    // window k+2's read started when window k+1's did, one window (at least WINDOW_RECORDS * MIN_RECORD_PX) earlier.
    const leadPx = (READ_AHEAD_WINDOWS - 1) * WINDOW_RECORDS * MIN_RECORD_PX + TIMELINE_DRAW_DISTANCE;
    expect(leadPx).toBeGreaterThanOrEqual(leadNeededPx);
});

test('one window lasts longer than a read, so the reads keep up with the wheel', () => {
    const windowSeconds = WINDOW_RECORDS * MIN_RECORD_PX / FASTEST_WHEEL_PX_PER_S;
    expect(windowSeconds * 1000).toBeGreaterThanOrEqual(READ_AHEAD_WINDOWS * P90_WINDOW_READ_MS * MARGIN);
});

test('the draw distance alone (the 979ed9f4e page: one window per request) is not enough: the check catches it', () => {
    expect(TIMELINE_DRAW_DISTANCE).toBeLessThan(leadNeededPx);
});
