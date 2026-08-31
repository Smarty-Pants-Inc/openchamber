import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

type FetchCall = {
  path: string;
  init?: RuntimeFetchOptions;
};

const sendOrder: string[] = [];
const fetchCalls: FetchCall[] = [];
let response = new Response(JSON.stringify({ authorized: true }), { status: 200 });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RuntimeFetchOptions) => {
    sendOrder.push('preflight');
    fetchCalls.push({ path, init });
    return response;
  },
}));

// The runtime fetch mock must be installed before the module under test loads.
const { withSessionSendPreflight } = await import('./session-send-preflight');

beforeEach(() => {
  fetchCalls.length = 0;
  sendOrder.length = 0;
  response = new Response(JSON.stringify({ authorized: true }), { status: 200 });
});

describe('withSessionSendPreflight', () => {
  test('authorizes immediately before sending and preserves the send result', async () => {
    const result = await withSessionSendPreflight({
      sessionId: 'session/one',
      directory: ' /canonical/worktree ',
      providerID: 'pi',
    }, async () => {
      sendOrder.push('send');
      return 'sent';
    });

    expect(result).toBe('sent');
    expect(sendOrder).toEqual(['preflight', 'send']);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.path).toBe('/api/openchamber/sessions/session%2Fone/send-preflight');
    expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({
      directory: '/canonical/worktree',
      providerID: 'pi',
    }));
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
  });

  test('preserves send errors', async () => {
    const sendError = new Error('send failed');

    let caught: Error | null = null;
    try {
      await withSessionSendPreflight({
        sessionId: 'session-one',
        directory: '/canonical/worktree',
        providerID: 'pi',
      }, async () => {
        throw sendError;
      });
    } catch (error) {
      if (error === sendError) caught = sendError;
    }

    expect(caught).toBe(sendError);
  });
});
