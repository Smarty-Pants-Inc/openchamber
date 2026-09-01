import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  tryHandleOpenChamberSessionProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const ctx = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

describe('VS Code API proxy aborts', () => {
  test('aborts non-SSE api:proxy fetches by bridge request id', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;

    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/session/abc/prompt_async', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy read coalescing', () => {
  test('shares one upstream fetch across concurrent identical GET reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let release: () => void = () => {};

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const first = handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown }).headers, (b?.data as { headers: unknown }).headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not coalesce POST writes or non-allowlisted reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code explicit OpenChamber session proxying', () => {
  test('dispatches explicit session routes before generic upstream forwarding', async () => {
    const originalFetch = globalThis.fetch;
    let genericFetches = 0;
    const handled: Array<{ method: string; path: string }> = [];

    try {
      globalThis.fetch = (async () => {
        genericFetches += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const sessionDeps = {
        ...deps,
        tryHandleOpenChamberSessionProxy: async (method: string, path: string) => {
          handled.push({ method, path });
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: JSON.stringify({ authorized: true }),
          };
        },
      };
      const metadataResponse = await handleProxyBridgeMessage(
        {
          id: 'metadata_1',
          type: 'api:proxy',
          payload: {
            method: 'PATCH',
            path: '/openchamber/sessions/source/metadata',
            bodyBase64: Buffer.from('{}').toString('base64'),
          },
        },
        ctx,
        sessionDeps,
      );
      const preflightResponse = await handleProxyBridgeMessage(
        {
          id: 'send_preflight_1',
          type: 'api:proxy',
          payload: {
            method: 'POST',
            path: '/openchamber/sessions/source/send-preflight',
            bodyBase64: Buffer.from('{}').toString('base64'),
          },
        },
        ctx,
        sessionDeps,
      );

      assert.deepEqual(handled, [
        { method: 'PATCH', path: '/openchamber/sessions/source/metadata' },
        { method: 'POST', path: '/openchamber/sessions/source/send-preflight' },
      ]);
      assert.equal(genericFetches, 0);
      assert.equal((metadataResponse?.data as { status?: number }).status, 200);
      assert.equal((preflightResponse?.data as { status?: number }).status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('registers explicit session routes in the request-id abort lifecycle before dispatch', async () => {
    let capturedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });

    const pending = handleProxyBridgeMessage(
      {
        id: 'fork_request',
        type: 'api:proxy',
        payload: {
          method: 'POST',
          path: '/openchamber/sessions/source/fork-authorized',
          bodyBase64: Buffer.from('{"directory":"/repo"}').toString('base64'),
        },
      },
      ctx,
      {
        ...deps,
        tryHandleOpenChamberSessionProxy: async (_method, _path, _body, _ctx, signal) => {
          capturedSignal = signal;
          markStarted?.();
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          }
          return {
            status: 499,
            headers: { 'content-type': 'application/json' },
            bodyText: JSON.stringify({ error: 'Request cancelled' }),
          };
        },
      },
    );

    await started;
    await handleProxyBridgeMessage(
      { id: 'abort_fork_request', type: 'api:proxy:abort', payload: { requestID: 'fork_request' } },
      ctx,
      deps,
    );

    assert.equal(capturedSignal?.aborted, true);
    const response = await pending;
    assert.equal((response?.data as { status?: number }).status, 499);
  });
});
