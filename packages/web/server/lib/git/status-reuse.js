// smarty-code#712 route 4: one GET /api/git/status costs several git processes (rev-parse twice, status -uall, two diff
// --numstat, the base-ref reads) plus up to 200 new-file reads split into lines on the event loop, and every open page
// and worktree asks for it on its own timer. So one read per (directory, mode) at a time: callers join the read in
// flight, and its answer is reused for a short time after it SETTLES. Any git write (a non-GET /api/git route) starts a
// new generation: no read begun before it is joined or reused after it, so a person's own stage or commit always shows.
export function createStatusReuse({ reuseMs = 2000, now = () => Date.now() } = {}) {
  const entries = new Map();
  let generation = 0;
  return {
    get(key, load) {
      const entry = entries.get(key);
      if (entry && entry.generation === generation && (!entry.settledAt || now() - entry.settledAt < reuseMs)) return entry.promise;
      const mine = { generation, settledAt: 0, promise: null };
      mine.promise = Promise.resolve().then(load).then(
        (value) => { mine.settledAt = now(); return value; },
        (error) => { if (entries.get(key) === mine) entries.delete(key); throw error; }, // A failure is never reused.
      );
      entries.set(key, mine);
      return mine.promise;
    },
    invalidate() { generation += 1; entries.clear(); },
  };
}
