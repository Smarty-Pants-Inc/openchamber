import { expect, test } from 'bun:test';
import { initialScrollFor, readerPlace } from './readerPlace';

// openchamber#457 review 1, P2 1: the reader scrolled up while the index was building; when the first positions arrive the
// timeline is mounted anew (for the whole session's layout). It must open where the reader was, not at the latest rows.
const rows = ['msg:a', 'msg:b', 'msg:c', 'msg:d'].map((key) => ({ key }));
const state = (over: Partial<Parameters<typeof readerPlace>[0] & object>) => ({ isAtEnd: false, start: 1, scroll: 1_050, data: rows, positionAtIndex: (i: number) => i * 1_000, ...over });

test('a reader who scrolled up keeps the first row in view and its offset across the remount', () => {
    const place = readerPlace(state({}));
    expect(place).toEqual({ key: 'msg:b', viewOffset: -50 });
    const next = [{ key: 'gap:0' }, { key: 'gap:100' }, ...rows];
    expect(initialScrollFor(place, next)).toEqual({ initialScrollAtEnd: false, initialScrollIndex: { index: 3, viewOffset: -50 } });
});

test('a reader at the latest rows still opens at the end (counterexample)', () => {
    expect(readerPlace(state({ isAtEnd: true }))).toBeUndefined();
    expect(initialScrollFor(undefined, rows)).toEqual({ initialScrollAtEnd: true });
});

test('a reader row missing from the new entries falls back to the end', () => {
    expect(initialScrollFor({ key: 'msg:gone', viewOffset: 0 }, rows)).toEqual({ initialScrollAtEnd: true });
});
