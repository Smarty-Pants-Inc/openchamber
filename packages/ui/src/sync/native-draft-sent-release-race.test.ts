import { afterEach, expect, test } from 'bun:test';
import { holdSentStart, releaseSentStart, resetSentStartsForPage } from './native-draft-sent';

const requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Gate = {
  callbackDone: Promise<void>;
  resolveCallbackDone: () => void;
  releaseRequest: () => void;
  settled: boolean;
};

type InstalledLocks = {
  gates: Gate[];
  requests: Promise<void>[];
  restore: () => void;
};

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

function installLocks(available = true): InstalledLocks {
  const gates: Gate[] = [];
  const requests: Promise<void>[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const manager = {
    request: (name: string, callback: (lock: Lock) => Promise<void>) => {
      const callbackDone = deferred();
      const requestRelease = deferred();
      const gate: Gate = { callbackDone: callbackDone.promise, resolveCallbackDone: callbackDone.resolve,
        releaseRequest: requestRelease.resolve, settled: false };
      gates.push(gate);
      const request = callback({ name, mode: 'exclusive' }).then(async () => {
        gate.resolveCallbackDone();
        await requestRelease.promise;
        gate.settled = true;
      });
      requests.push(request);
      return request;
    },
    query: async () => ({ held: [], pending: [] }),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: available ? manager : undefined } });
  return {
    gates,
    requests,
    restore: () => {
      for (const gate of gates) gate.releaseRequest();
      if (previous) Object.defineProperty(globalThis, 'navigator', previous);
      else Reflect.deleteProperty(globalThis, 'navigator');
    },
  };
}

afterEach(() => resetSentStartsForPage());

test('duplicate release callers share the pending browser lock request', async () => {
  const locks = installLocks();
  try {
    holdSentStart(requestId);
    const first = releaseSentStart(requestId);
    await locks.gates[0]!.callbackDone;
    const second = releaseSentStart(requestId);
    holdSentStart(requestId);
    expect(locks.gates).toHaveLength(1);
    expect(second).toBe(first);
    expect(locks.gates[0]!.settled).toBe(false);

    locks.gates[0]!.releaseRequest();
    await first;
    expect(locks.gates[0]!.settled).toBe(true);
    holdSentStart(requestId);
    expect(locks.gates).toHaveLength(2);
    const next = releaseSentStart(requestId);
    locks.gates[1]!.releaseRequest();
    await next;
    await Promise.all(locks.requests);
  } finally {
    locks.restore();
  }
});

test('without Web Locks a live Send keeps its owner until release', async () => {
  const locks = installLocks(false);
  try {
    holdSentStart(requestId);
    await Promise.resolve();
    await Promise.resolve();
    const first = releaseSentStart(requestId);
    expect(releaseSentStart(requestId)).toBe(first);
    await first;
    expect(locks.requests).toHaveLength(0);
  } finally {
    locks.restore();
  }
});

test('late cleanup cannot release a newer same-ID entry', async () => {
  const locks = installLocks();
  try {
    holdSentStart(requestId);
    const oldRelease = releaseSentStart(requestId);
    await locks.gates[0]!.callbackDone;

    // Model a page owner ending while its browser request is still settling.
    resetSentStartsForPage();
    holdSentStart(requestId);
    let newerCallbackReleased = false;
    void locks.gates[1]!.callbackDone.then(() => { newerCallbackReleased = true; });

    locks.gates[0]!.releaseRequest();
    await oldRelease;
    expect(newerCallbackReleased).toBe(false);
    expect(locks.gates[1]!.settled).toBe(false);
    holdSentStart(requestId);
    expect(locks.gates).toHaveLength(2);
    const newRelease = releaseSentStart(requestId);
    await locks.gates[1]!.callbackDone;
    expect(releaseSentStart(requestId)).toBe(newRelease);

    locks.gates[1]!.releaseRequest();
    await newRelease;
    await Promise.all(locks.requests);
  } finally {
    locks.restore();
  }
});
