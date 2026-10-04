import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

const deps = {
  tryHandleLocalFsProxy: async () => null,
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

describe('VS Code disabled permission policy namespace', () => {
  test('refuses every policy route before host effects and preserves manual replies and reads', async () => {
    const incoming: Array<{ method: string; path: string; body: string }> = [];
    const upstream = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      incoming.push({ method: request.method ?? '', path: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    // SAFETY: the completed listen above binds a TCP port, not a Unix socket.
    const address = upstream.address() as AddressInfo;
    const effects: string[] = [];
    const poison = (effect: string): never => {
      effects.push(effect);
      throw new Error(`Unexpected ${effect}`);
    };
    const poisonedContext: BridgeContext = { get manager() { return poison('manager'); } };
    const poisonedDeps = {
      tryHandleLocalFsProxy: async () => poison('localFs'),
      buildUnavailableApiResponse: () => poison('unavailable'),
      sanitizeForwardHeaders: () => poison('headers'),
      collectHeaders: () => poison('response headers'),
      base64EncodeUtf8: () => poison('body encoding'),
    };
    const bodyBase64 = Buffer.from('{"sessionId":"root","enabled":true}').toString('base64');
    const paths = [
      '/permission-auto-accept', '/permission-auto-accept/',
      '/permission-auto-accept?directory=%2Fproject', '/permission-auto-accept/sessions/root',
      '/permission-auto-accept/sessions/root/child', '/permission-auto-accept/arbitrary/?enabled=true',
      '/notifications/auto-accept', '/notifications/auto-accept/',
      '/notifications/auto-accept?enabled=true', '/notifications/auto-accept/child',
      '/%70ermission-auto-accept/sessions/root', '/notifications/%61uto-accept/child',
      '/permission-auto-accept%2Fsessions%2Froot', '/notifications%2Fauto-accept',
      '/other/../permission-auto-accept', '/other/%2e%2e/notifications/auto-accept',
      '/other%2F..%2Fpermission-auto-accept', '//permission-auto-accept//sessions/root',
      '/permission-auto-accept/invalid%ZZ',
      '/API/PERMISSION-AUTO-ACCEPT/session', '/api/NOTIFICATIONS/AUTO-ACCEPT',
      '/PERMISSION-AUTO-ACCEPT/sessions/root', '/NOTIFICATIONS/AUTO-ACCEPT/child',
    ];
    const originalApiUrl = ctx.manager!.getApiUrl;
    const originalAuthHeaders = ctx.manager!.getOpenCodeAuthHeaders;
    try {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'CUSTOM']) {
        for (const path of paths.flatMap((path) => /^\/api\//i.test(path) ? [path] : [path, `/api${path}`])) {
          const response = await handleProxyBridgeMessage(
            { id: `${method}:${path}`, type: 'api:proxy', payload: { method, path, bodyBase64 } },
            poisonedContext,
            poisonedDeps,
          );
          assert.equal(response?.success, true);
          assert.deepEqual(response?.data, {
            status: 501,
            headers: { 'content-type': 'application/json' },
            bodyText: JSON.stringify({ error: 'Permission auto-accept is unsupported in this fork', supported: false }),
          }, `${method} ${path}`);
        }
      }
      for (const path of paths) {
        const response = await handleProxyBridgeMessage(
          { id: `session:${path}`, type: 'api:session:message', payload: { path, bodyText: '{}' } },
          poisonedContext,
          poisonedDeps,
        );
        assert.equal(response?.success, true);
        assert.deepEqual(response?.data, {
          status: 501,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'Permission auto-accept is unsupported in this fork', supported: false }),
        }, path);
      }
      assert.equal(effects.length, 0, 'no manager, auth, local filesystem or other dependency access');
      assert.equal(incoming.length, 0, 'no network request for disabled routes');

      ctx.manager!.getApiUrl = () => `http://127.0.0.1:${address.port}`;
      ctx.manager!.getOpenCodeAuthHeaders = () => { effects.push('auth'); return {}; };
      const allowedDeps = {
        ...deps,
        tryHandleLocalFsProxy: async () => { effects.push('localFs'); return null; },
        collectHeaders: () => ({}),
      };
      for (const reply of ['once', 'always', 'reject']) {
        const response = await handleProxyBridgeMessage({
          id: `manual:${reply}`, type: 'api:proxy', payload: {
            method: 'POST', path: '/permission/manual/reply?directory=%2Fproject',
            bodyBase64: Buffer.from(JSON.stringify({ reply })).toString('base64'),
          },
        }, ctx, allowedDeps);
        assert.deepEqual(response?.data, {
          status: 200, headers: {}, bodyText: '{"ok":true}',
        });
      }
      for (const path of ['/config?directory=%2Fproject', '/permission/manual',
        '/permission-auto-acceptance', '/notifications/auto-acceptance',
        '/session?next=/permission-auto-accept', '/permission/manual?next=%2Fnotifications%2Fauto-accept']) {
        const response = await handleProxyBridgeMessage(
          { id: `read:${path}`, type: 'api:proxy', payload: { method: 'GET', path } }, ctx, allowedDeps,
        );
        assert.ok(response?.success);
        assert.deepEqual(response.data, { status: 200, headers: {}, bodyText: '{"ok":true}' });
      }
      assert.deepEqual(incoming.slice(0, 3).map((request) => ({ ...request, body: JSON.parse(request.body) })),
        ['once', 'always', 'reject'].map((reply) => ({
          method: 'POST', path: '/permission/manual/reply?directory=%2Fproject', body: { reply },
        })));
      assert.equal(incoming.length, 9);
      assert.equal(effects.filter((effect) => effect === 'auth').length, 9);
      assert.equal(effects.filter((effect) => effect === 'localFs').length, 9);
    } finally {
      ctx.manager!.getApiUrl = originalApiUrl;
      ctx.manager!.getOpenCodeAuthHeaders = originalAuthHeaders;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

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
