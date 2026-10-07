import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedStart523 } from './startRelease523.fixture';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

let mounted: Awaited<ReturnType<typeof mountedStart523>> | undefined;
let restoreLocks: (() => void) | undefined;

afterEach(async () => {
  restoreLocks?.(); restoreLocks = undefined;
  await mounted?.dispose(); mounted = undefined;
});

for (const oldReceiptFirst of [false, true]) test(
  `a Stop and old finally share the lock release before a new Send, old receipt first=${oldReceiptFirst}`,
  async () => {
    const c = mounted = await mountedStart523('trust');
    const navigatorObject = navigator;
    const previousLocks = Object.getOwnPropertyDescriptor(navigatorObject, 'locks');
    const unlocked = deferred(), releaseCalled = deferred();
    const held = new Set<string>();
    const manager = {
      request: (name: string, callback: (lock: Lock) => Promise<void>) => {
        held.add(name);
        return callback({ name, mode: 'exclusive' }).then(async () => {
          releaseCalled.resolve();
          await unlocked.promise;
          held.delete(name);
        });
      },
      query: async () => ({ held: [...held].map(name => ({ name })), pending: [] }),
    };
    Object.defineProperty(navigatorObject, 'locks', { configurable: true, value: manager });
    restoreLocks = () => {
      if (previousLocks) Object.defineProperty(navigatorObject, 'locks', previousLocks);
      else Reflect.deleteProperty(navigatorObject, 'locks');
    };

    const now = Date.now; let clock = now(); Date.now = () => clock;
    try {
      await c.replace('lock release race A'); await c.submit(); await c.server.entered; await c.refresh();
      clock += 60_001; await c.refresh();
      await c.clickStop(); await releaseCalled.promise;
      expect(c.server.operation().phase).toBe('cancelled');
      expect(c.server.state.abandons).toHaveLength(1);
      expect(c.server.state.actions).toEqual(['trust']);
      expect(c.server.held[0]!.released).toBe(false);
      expect(held.size).toBe(1);
      expect(c.starting()).toBe(true);

      if (oldReceiptFirst) {
        await act(async () => { c.server.release(0, 'cancelled'); await sleep(30); });
        const startingBeforeNewSend = c.starting();
        await c.submit(); await act(async () => { await sleep(20); });
        console.log(JSON.stringify({ oldReceiptFirst, startingBeforeNewSend, heldLockRequests: held.size,
          creates: c.creates().length, prompts: c.prompts().length, text: c.text() }));
        expect(startingBeforeNewSend).toBe(true);
        expect(c.creates()).toHaveLength(1);
        expect(c.prompts()).toHaveLength(0);
        expect(c.text()).toBe('lock release race A');
      } else {
        unlocked.resolve(); await act(async () => { await sleep(30); });
        await act(async () => { c.server.release(0, 'cancelled'); await sleep(30); });
      }

      unlocked.resolve(); await act(async () => { await sleep(30); });
      expect(held.size).toBe(0);
      expect(c.starting()).toBe(false);
      expect(c.text()).toBe('lock release race A');
      expect(c.prompts()).toHaveLength(0);
      await c.submit(); await act(async () => { await sleep(30); });
      expect(c.creates()).toHaveLength(2);
      expect(c.prompts()).toHaveLength(1);
    } finally {
      await act(async () => { unlocked.resolve(); c.server.release(0, 'cancelled'); await sleep(20); });
      Date.now = now;
    }
  },
);
