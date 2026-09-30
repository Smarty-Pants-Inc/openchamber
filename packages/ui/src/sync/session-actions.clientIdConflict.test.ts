import { expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from './child-store';
import { useNotificationStore } from './notification-store';
import { optimisticSend, setActionRefs, setOptimisticRefs } from './session-actions';

// openchamber#375 review 4 (P2 3): a re-send reuses its first attempt's client ID; while that attempt is held (or after it
// was delivered) the gateway refuses the re-send as a reservation conflict. That refusal is not the message's: the
// first attempt's row stays, and no refusal is written into the chat. The caller still sees an error (not acceptance).
test('a conflicting re-send of a held original keeps the row and adds no error notification', async () => {
  const children = new ChildStoreManager();
  const removed: string[] = [];
  // SAFETY: optimisticSend calls only `send` here; the SDK client is never reached.
  setActionRefs({} as OpencodeClient, children, () => '/target/project');
  setOptimisticRefs(({ sessionID, message, parts }) => {
    const store = children.ensureChild('/target/project');
    store.setState(state => ({ message: { ...state.message, [sessionID]: [...(state.message[sessionID] ?? []).filter(m => m.id !== message.id), message] },
      part: { ...state.part, [message.id]: parts } }));
  }, ({ sessionID, messageID }) => {
    removed.push(messageID);
    const store = children.ensureChild('/target/project');
    store.setState(state => ({ message: { ...state.message, [sessionID]: (state.message[sessionID] ?? []).filter(m => m.id !== messageID) } }));
  });
  useConfigStore.setState({ isConnected: true });
  const reason = 'Client message ID already exists or a submission is pending';
  const base = { sessionId: 'session-dedup', directory: '/target/project', content: 'hello', providerID: 'provider', modelID: 'model', messageID: 'msg_same' };

  let release!: () => void;
  const original = optimisticSend({ ...base, send: () => new Promise<void>(resolve => { release = resolve; }) });
  await expect(optimisticSend({ ...base,
    send: async () => { throw Object.assign(new Error(reason), { status: 409, refusalReason: reason }); } })).rejects.toThrow(reason);

  expect(removed).toEqual([]);
  expect(children.getChild('/target/project')?.getState().message['session-dedup']?.map(m => m.id)).toEqual(['msg_same']);
  expect(useNotificationStore.getState().list.some(entry => entry.session === 'session-dedup')).toBe(false);
  release(); await original;
  children.disposeAll();
});

// smarty-code#962 (1): a conflicting re-send of a DELIVERED message keeps that row's parts as they are (the re-send's
// optimistic parts never replace them until the next read).
test('a conflicting re-send of a delivered message leaves its row and its parts unchanged', async () => {
  const children = new ChildStoreManager();
  // SAFETY: optimisticSend calls only `send` here; the SDK client is never reached.
  setActionRefs({} as OpencodeClient, children, () => '/target/project');
  setOptimisticRefs(({ sessionID, message, parts }) => {
    const store = children.ensureChild('/target/project');
    store.setState(state => ({ message: { ...state.message, [sessionID]: [...(state.message[sessionID] ?? []).filter(m => m.id !== message.id), message] },
      part: { ...state.part, [message.id]: parts } }));
  }, () => undefined);
  useConfigStore.setState({ isConnected: true });
  const store = children.ensureChild('/target/project');
  // SAFETY: the delivered row and its part carry the fields this path reads.
  const delivered = { id: 'msg_done', role: 'user', sessionID: 'session-delivered', time: { created: 1 } } as never;
  // SAFETY: as above, a text part with the fields the store keeps.
  const parts = [{ id: 'prt_done', type: 'text', text: 'hello', messageID: 'msg_done', sessionID: 'session-delivered' }] as never;
  store.setState(state => ({ message: { ...state.message, 'session-delivered': [delivered] }, part: { ...state.part, msg_done: parts } }));
  const reason = 'Client message ID already exists or a submission is pending';
  await expect(optimisticSend({ sessionId: 'session-delivered', directory: '/target/project', content: 'hello', providerID: 'provider',
    modelID: 'model', messageID: 'msg_done',
    send: async () => { throw Object.assign(new Error(reason), { status: 409, refusalReason: reason }); } })).rejects.toThrow(reason);
  expect(store.getState().message['session-delivered']).toEqual([delivered]);
  expect(store.getState().part.msg_done).toBe(parts);
  children.disposeAll();
});
