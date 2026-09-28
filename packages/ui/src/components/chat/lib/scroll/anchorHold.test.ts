import { describe, expect, test } from 'bun:test';
import { READER_INTENT_EVENTS, runAnchorHold, type AnchorHoldTarget } from './anchorHold';

// review/astra OC#334: the prepend hold must yield to the reader and recover a missing anchor from the CURRENT mapping.

const makeTarget = () => {
    const listeners = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    let anchorTop: number | null = 300; // the anchor element's top inside the container (null: unmounted)
    const mapping = { current: new Map<string, number>([['m1', 4]]) };
    const scrolled: number[] = [];
    const container = {
        scrollTop: 0,
        addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn); },
        removeEventListener: (name: string) => { listeners.delete(name); },
        getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
    };
    const target: AnchorHoldTarget = {
        container: container as unknown as AnchorHoldTarget['container'],
        findElement: () => (anchorTop === null ? null : { getBoundingClientRect: () => ({ top: anchorTop! - container.scrollTop }) as DOMRect }),
        scrollAnchorRowIntoView: (id) => { const index = mapping.current.get(id); if (index === undefined) return false; scrolled.push(index); return true; },
        requestFrame: (step) => { frames.push(step); },
    };
    const runFrames = (n: number) => { for (let i = 0; i < n && frames.length; i++) frames.shift()!(); };
    return { target, container, listeners, runFrames, frames, scrolled, mapping,
        setAnchorTop: (top: number | null) => { anchorTop = top; } };
};
const defaults = { stableFrames: 3, maxFrames: 20 };

describe('prepend anchor hold (smarty-code#583)', () => {
    test('holds the anchor at its offset: applies only the remaining difference', () => {
        const t = makeTarget();
        runAnchorHold(t.target, { messageId: 'm1', offsetTop: 100 }, {}, defaults);
        t.runFrames(1);
        expect(t.container.scrollTop).toBe(200); // 300 - 100
        t.runFrames(5);
        expect(t.container.scrollTop).toBe(200); // steady: no further writes, then it ends
        expect(t.frames.length).toBe(0);
    });

    for (const name of READER_INTENT_EVENTS) {
        test(`reader input (${name}) ends the hold at once, and it never pulls the view back`, () => {
            const t = makeTarget();
            runAnchorHold(t.target, { messageId: 'm1', offsetTop: 100 }, {}, defaults);
            t.listeners.get(name)!();
            t.runFrames(5);
            expect(t.container.scrollTop).toBe(0);
            expect(t.listeners.size).toBe(0);
        });
    }

    test('explicit navigation (the returned stop) ends the hold', () => {
        const t = makeTarget();
        const stop = runAnchorHold(t.target, { messageId: 'm1', offsetTop: 100 }, {}, defaults);
        stop();
        t.runFrames(5);
        expect(t.container.scrollTop).toBe(0);
    });

    test('a missing anchor is brought back through the CURRENT mapping, including the last row', () => {
        const t = makeTarget();
        t.setAnchorTop(null);
        runAnchorHold(t.target, { messageId: 'm1', offsetTop: 100 }, { restoreMissing: true }, defaults);
        t.runFrames(1);
        t.mapping.current = new Map([['m1', 9]]); // the page regrouped rows: the anchor's row is now index 9 (the last)
        t.runFrames(1);
        expect(t.scrolled).toEqual([4, 9]);
        t.setAnchorTop(420);
        t.runFrames(1);
        expect(t.container.scrollTop).toBe(320);
    });

    test('without restoreMissing, a missing anchor is left alone', () => {
        const t = makeTarget();
        t.setAnchorTop(null);
        runAnchorHold(t.target, { messageId: 'm1', offsetTop: 100 }, {}, defaults);
        t.runFrames(3);
        expect(t.scrolled).toEqual([]);
    });
});
