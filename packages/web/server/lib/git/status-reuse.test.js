import { describe, expect, it } from 'vitest';
import { createStatusReuse } from './status-reuse.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('git status reuse (smarty-code#712)', () => {
  it('callers join the read in flight; it is reused for reuseMs after it settles, then read again', async () => {
    let t = 0, reads = 0; const held = deferred();
    const reuse = createStatusReuse({ reuseMs: 2000, now: () => t });
    const load = () => { reads += 1; return held.promise; };
    const a = reuse.get('k', load), b = reuse.get('k', load);
    t = 5000; // The read is slow: still joined, however long it takes (held until it settles).
    const c = reuse.get('k', load);
    held.resolve({ files: [] });
    expect(await Promise.all([a, b, c])).toEqual([{ files: [] }, { files: [] }, { files: [] }]);
    expect(reads).toBe(1);
    t = 6999; await reuse.get('k', load); expect(reads).toBe(1); // 1999 ms after it settled: reused.
    t = 7000; reuse.get('k', () => { reads += 1; return Promise.resolve({}); }); expect(reads).toBe(1);
    await Promise.resolve(); expect(reads).toBe(2); // 2000 ms: a new read.
  });

  it('keys are separate (directory and mode)', async () => {
    let reads = 0; const reuse = createStatusReuse();
    await Promise.all([reuse.get('full\0/a', async () => { reads += 1; }), reuse.get('light\0/a', async () => { reads += 1; }), reuse.get('full\0/b', async () => { reads += 1; })]);
    expect(reads).toBe(3);
  });

  it('a failed read is never reused', async () => {
    let reads = 0; const reuse = createStatusReuse();
    await expect(reuse.get('k', async () => { reads += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    await reuse.get('k', async () => { reads += 1; return 1; });
    expect(reads).toBe(2);
  });

  it('a git write invalidates: a read begun before it is neither joined nor reused after it', async () => {
    let reads = 0; const held = deferred(); const reuse = createStatusReuse();
    const before = reuse.get('k', () => { reads += 1; return held.promise; });
    reuse.invalidate(); // A stage or commit starts.
    const after = reuse.get('k', async () => { reads += 1; return 'after'; });
    held.resolve('before');
    expect(await before).toBe('before'); expect(await after).toBe('after'); expect(reads).toBe(2);
    await reuse.get('k', async () => { reads += 1; return 'x'; }); expect(reads).toBe(2); // 'after' is reused.
  });

  it('a fresh read bypasses a settled answer and a read in flight; later callers join the fresh one, never the older', async () => {
    let t = 0, reads = 0; const older = deferred(), fresher = deferred();
    const reuse = createStatusReuse({ reuseMs: 2000, now: () => t });
    await reuse.get('k', async () => { reads += 1; return 'settled'; });
    expect(await reuse.get('k', async () => { reads += 1; return 'fresh-1'; }, { fresh: true })).toBe('fresh-1'); // Not the settled one.
    const before = reuse.get('k', () => { reads += 1; return older.promise; }, { fresh: true }); // A read in flight...
    const forced = reuse.get('k', () => { reads += 1; return fresher.promise; }, { fresh: true }); // ...and a forced one after it.
    const joined = reuse.get('k', async () => { reads += 1; return 'never'; });
    fresher.resolve('after bootstrap'); older.resolve('before bootstrap');
    expect(await forced).toBe('after bootstrap'); expect(await joined).toBe('after bootstrap'); expect(await before).toBe('before bootstrap');
    expect(await reuse.get('k', async () => { reads += 1; return 'never'; })).toBe('after bootstrap'); // The older never replaced it.
    expect(reads).toBe(4);
  });
});
