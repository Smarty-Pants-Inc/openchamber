import { expect, test } from 'bun:test';
import { createWindowQueue } from './windowQueue';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one read at a time, the latest request wins', async () => {
    const reads: string[] = [], first = deferred();
    const queue = createWindowQueue(async (start) => { reads.push(`${start}`); if (start === 0) await first.promise; }, () => true);
    queue(0, 200); queue(100, 200); queue(900, 200);
    await tick(); first.resolve(); await tick(); await tick();
    expect(reads).toEqual(['0', '900']);
});

// openchamber#363 review round 2 (P2): a slow read of session A, then the reader switches to B and reaches a B gap.
test('a session switch during a slow read: A reads nothing more, B reads its own window', async () => {
    const reads: string[] = [], slow = deferred();
    let shown = 'A';
    const queueA = createWindowQueue(async (start) => { reads.push(`A:${start}`); await slow.promise; }, () => shown === 'A');
    const queueB = createWindowQueue(async (start) => { reads.push(`B:${start}`); }, () => shown === 'B');
    queueA(500, 200);
    queueA(700, 200); // waits behind the slow read
    await tick();
    shown = 'B';
    queueB(300, 200);
    slow.resolve(); await tick(); await tick();
    expect(reads).toEqual(['A:500', 'B:300']);
});
