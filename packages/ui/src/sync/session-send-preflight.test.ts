import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BoundRuntimeTransport, RuntimeFetchOptions } from '@/lib/runtime-fetch';

type FetchCall = {
  path: string;
  init?: RuntimeFetchOptions;
};

const fetchCalls: FetchCall[] = [];
let response = new Response(JSON.stringify({ authorized: true }), { status: 200 });
let runtimeKey = 'runtime-a';
let runtimeTransportEpoch = 0;
let releases = 0;
let onAuthorize: (() => void) | null = null;

const transportFetch: BoundRuntimeTransport['fetch'] = async (input, init) => {
  const path = input instanceof Request ? input.url : input.toString();
  fetchCalls.push({ path, init });
  if (path.includes('/send-preflight')) {
    onAuthorize?.();
    return response;
  }
  return new Response(JSON.stringify(true), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

mock.module('@/lib/runtime-fetch', () => ({
  bindRuntimeTransport: () => ({
    apiBaseUrl: 'https://runtime-a.test/api',
    fetch: transportFetch,
    release: () => {
      releases += 1;
    },
  }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  getRuntimeTransportEpoch: () => runtimeTransportEpoch,
}));

// Load after installing module mocks so the helper captures this test transport.

const { withSessionSendPreflight } = await import('./session-send-preflight');

beforeEach(() => {
  fetchCalls.length = 0;
  response = new Response(JSON.stringify({ authorized: true }), { status: 200 });
  runtimeKey = 'runtime-a';
  runtimeTransportEpoch = 0;
  releases = 0;
  onAuthorize = null;
});

describe('withSessionSendPreflight', () => {
  test('authorizes immediately before sending and preserves the send result', async () => {
    const result = await withSessionSendPreflight({
      sessionId: 'session/one',
      directory: ' /canonical/worktree ',
      providerID: 'pi',
    }, async ({ runtimeKey: capturedRuntimeKey }) => {
      expect(capturedRuntimeKey).toBe('runtime-a');
      return 'sent';
    });

    expect(result).toBe('sent');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.path).toBe('/api/openchamber/sessions/session%2Fone/send-preflight');
    expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({
      directory: '/canonical/worktree',
      providerID: 'pi',
    }));
    expect(releases).toBe(1);
  });

  test('does not send when authorization fails', async () => {
    response = new Response(JSON.stringify({ error: 'backend mismatch' }), { status: 409 });
    let sendCalls = 0;

    await expect(withSessionSendPreflight({
      sessionId: 'session-one',
      directory: '/canonical/worktree',
      providerID: 'pi',
    }, async () => {
      sendCalls += 1;
      return 'sent';
    })).rejects.toThrow('backend mismatch');

    expect(sendCalls).toBe(0);
    expect(releases).toBe(1);
  });

  test('cancels when the runtime changes while authorization is in flight', async () => {
    onAuthorize = () => {
      runtimeKey = 'runtime-b';
      runtimeTransportEpoch += 1;
    };
    let sendCalls = 0;

    await expect(withSessionSendPreflight({
      sessionId: 'session-one',
      directory: '/canonical/worktree',
      providerID: 'pi',
      runtimeKey: 'runtime-a',
    }, async () => {
      sendCalls += 1;
      return 'sent';
    })).rejects.toThrow('runtime changed');

    expect(sendCalls).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    expect(releases).toBe(1);
  });

  test('keeps callback dispatch on the captured transport after a later switch', async () => {
    const result = await withSessionSendPreflight({
      sessionId: 'session-one',
      directory: '/canonical/worktree',
      providerID: 'pi',
    }, async ({ client, runtimeKey: capturedRuntimeKey }) => {
      expect(capturedRuntimeKey).toBe('runtime-a');
      runtimeKey = 'runtime-b';
      runtimeTransportEpoch += 1;
      await client.session.summarize({
        sessionID: 'session-one',
        directory: '/canonical/worktree',
        providerID: 'pi',
        modelID: 'model-a',
      });
      return 'sent';
    });

    expect(result).toBe('sent');
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.path).toContain('https://runtime-a.test/api/session/session-one/summarize');
    expect(releases).toBe(1);
  });
});
