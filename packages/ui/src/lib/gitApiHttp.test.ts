import { describe, expect, test } from 'bun:test';
import {
  getGitBranches,
  getGitStatus,
} from './gitApiHttp';
import type { GitStatus } from './api/types';
import { sessionEvents } from './sessionEvents';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installFetchMock = () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
};

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
    },
  });
};

const restoreMocks = () => {
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
};

describe('gitApiHttp status cache', () => {
  test('a Git refresh hint invalidates the cached status before listeners fetch', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    globalThis.fetch = async () => {
      statusRequestCount += 1;
      return jsonResponse(statusPayload({ behind: statusRequestCount }));
    };

    try {
      const directory = '/repo-cache-tool-mutation';
      const first = await getGitStatus(directory);
      sessionEvents.requestGitRefresh({ directory });
      const afterMutation = await getGitStatus(directory);

      expect(first.behind).toBe(1);
      expect(afterMutation.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
    } finally {
      restoreMocks();
    }
  });

  test('fresh status bypasses an unexpired cached snapshot', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    globalThis.fetch = (async () => {
      statusRequestCount += 1;
      return jsonResponse(statusPayload({ behind: statusRequestCount }));
    }) as typeof fetch;

    try {
      const directory = '/repo-cache-fresh';
      const first = await getGitStatus(directory);
      const cached = await getGitStatus(directory);
      const fresh = await getGitStatus(directory, { fresh: true });

      expect(first.behind).toBe(1);
      expect(cached.behind).toBe(1);
      expect(fresh.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
    } finally {
      restoreMocks();
    }
  });

  test('fresh status cannot be replaced in cache by an older in-flight response', async () => {
    installWindowMock();
    const statusResolvers: Array<(response: Response) => void> = [];
    // SAFETY: the mock accepts the same arguments as fetch and always returns
    // a pending Response promise controlled by this test.
    globalThis.fetch = (async () => new Promise<Response>((resolve) => {
      statusResolvers.push(resolve);
    })) as typeof fetch;

    try {
      const directory = '/repo-cache-fresh-race';
      const older = getGitStatus(directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fresh = getGitStatus(directory, { fresh: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(statusResolvers).toHaveLength(2);
      statusResolvers[1](jsonResponse(statusPayload({ current: 'fresh' })));
      statusResolvers[0](jsonResponse(statusPayload({ current: 'stale' })));

      expect((await fresh).current).toBe('fresh');
      expect((await older).current).toBe('stale');
      expect((await getGitStatus(directory)).current).toBe('fresh');
      expect(statusResolvers).toHaveLength(2);
    } finally {
      restoreMocks();
    }
  });
});

const statusPayload = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const jsonResponse = <T>(payload: T) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('gitApiHttp request priority', () => {
  test('leaves low-level reads outside the background policy', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await getGitBranches('/repo-interactive');

      expect(calls).toHaveLength(1);
      expect(calls[0].init?.priority).toBe(undefined);
    } finally {
      restoreMocks();
    }
  });
});
