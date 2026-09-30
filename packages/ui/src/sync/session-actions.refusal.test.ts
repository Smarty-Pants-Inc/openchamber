import { expect, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from './child-store';
import { useNotificationStore } from './notification-store';
import { optimisticSend, setActionRefs, setOptimisticRefs } from './session-actions';

test("a refused send keeps the server's reason in the chat, not only a toast (F11)", async () => {
  const children = new ChildStoreManager();
  setActionRefs(createOpencodeClient({ baseUrl: 'http://opencode.test' }), children, () => '/target/project');
  setOptimisticRefs(() => {}, () => {});
  useConfigStore.setState({ isConnected: true });
  const reason = 'The page was out of date, so nothing was sent.';

  await expect(optimisticSend({
    sessionId: 'session-refused', directory: '/target/project', content: 'hello', providerID: 'provider', modelID: 'model',
    send: async () => { throw Object.assign(new Error(reason), { status: 409, refusalReason: reason }); },
  })).rejects.toThrow(reason);

  const notice = useNotificationStore.getState().list.filter((entry) => entry.session === 'session-refused').at(-1);
  // A definite 409 refusal says nothing was sent, not that a reply was stopped.
  expect(notice).toMatchObject({ type: 'error', sendOutcome: 'refused', error: { name: null, message: reason } });
  expect(children.getChild('/target/project')?.getState().session_status['session-refused']).toEqual({ type: 'idle' });
  children.disposeAll();
});

test('a failure without a server reason adds no chat notice', async () => {
  const children = new ChildStoreManager();
  setActionRefs(createOpencodeClient({ baseUrl: 'http://opencode.test' }), children, () => '/target/project');
  setOptimisticRefs(() => {}, () => {});
  useConfigStore.setState({ isConnected: true });
  await expect(optimisticSend({
    sessionId: 'session-plain', directory: '/target/project', content: 'hello', providerID: 'provider', modelID: 'model',
    send: async () => { throw Object.assign(new Error('Failed to send message (500)'), { status: 500 }); },
  })).rejects.toThrow('(500)');
  expect(useNotificationStore.getState().list.some((entry) => entry.session === 'session-plain')).toBe(false);
  children.disposeAll();
});
