import { spyOn } from 'bun:test';

/** Accelerated synthetic time, NOT a wall-clock runtime proof. Time advances only as real monotonic time elapses;
 * scheduling a long deadline never advances the clock. All newly scheduled JS timers use that same rate. */
export function readyRead931Clock(rate = 100) {
  const started = performance.now(), epoch = Date.now();
  const realSetTimeout = globalThis.setTimeout;
  const elapsed = () => (performance.now() - started) * rate;
  const now = spyOn(Date, 'now').mockImplementation(() => epoch + Math.floor(elapsed()));
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    realSetTimeout(callback, (delay ?? 0) / rate, ...args));
  return { elapsed, restore: () => { timer.mockRestore(); now.mockRestore(); } };
}
