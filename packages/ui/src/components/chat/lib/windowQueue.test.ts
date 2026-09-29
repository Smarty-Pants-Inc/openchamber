import { expect, test } from 'bun:test';
import { createWindowQueue } from './windowQueue';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one read at a time, the latest request wins', async () => {
    const reads: string[] = [], first = deferred();
    const queue = createWindowQueue(async (start) => { reads.push(`${start}`); if (start === 0) await first.promise; }, () => true);
    queue([{ start: 0, limit: 200 }]); queue([{ start: 100, limit: 200 }]); queue([{ start: 900, limit: 200 }]);
    await tick(); first.resolve(); await tick(); await tick();
    expect(reads).toEqual(['0', '900']);
});

// openchamber#363 review round 2 (P2): a slow read of session A, then the reader switches to B and reaches a B gap.
test('a session switch during a slow read: A reads nothing more, B reads its own window', async () => {
    const reads: string[] = [], slow = deferred();
    let shown = 'A';
    const queueA = createWindowQueue(async (start) => { reads.push(`A:${start}`); await slow.promise; }, () => shown === 'A');
    const queueB = createWindowQueue(async (start) => { reads.push(`B:${start}`); }, () => shown === 'B');
    queueA([{ start: 500, limit: 200 }]);
    queueA([{ start: 700, limit: 200 }]); // waits behind the slow read
    await tick();
    shown = 'B';
    queueB([{ start: 300, limit: 200 }]);
    slow.resolve(); await tick(); await tick();
    expect(reads).toEqual(['A:500', 'B:300']);
});

test('a request is read in order; a newer request replaces what is left of it', async () => {
    const reads: string[] = [], first = deferred();
    const queue = createWindowQueue(async (start) => { reads.push(`${start}`); if (start === 1000) await first.promise; }, () => true);
    queue([{ start: 1000, limit: 500 }, { start: 500, limit: 500 }]);
    await tick();
    queue([{ start: 9000, limit: 500 }, { start: 8500, limit: 500 }]);
    first.resolve(); await tick(); await tick(); await tick();
    expect(reads).toEqual(['1000', '9000', '8500']);
});
