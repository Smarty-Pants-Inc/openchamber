import { expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { optimisticMessageRecords } from './unsaved';
import { buildSessionMessageRecordsSnapshot } from './sync-context';

// smarty-code#1107: one accepted Send shows one user bubble while its client ID is not bound to its native entry yet.
const T = 1_790_000_000_000;
const user = (id: string, opts: { optimistic?: boolean; created?: number } = {}) => {
  const info = { id, sessionID: 's', role: 'user', time: { created: T + (opts.created ?? 0) } } as unknown as Message;
  if (opts.optimistic) optimisticMessageRecords.add(info);
  return info;
};
const text = (messageID: string, value: string) => [{ id: `${messageID}-p`, messageID, sessionID: 's', type: 'text', text: value }] as unknown as Part[];
const shown = (messages: Message[], parts: Record<string, Part[]>) =>
  buildSessionMessageRecordsSnapshot({ message: { s: messages }, part: parts, session: [] } as never, 's').list.map((r) => r.info.id);

test('the native entry of this Send (shown under its native id until its client ID is bound) takes its optimistic bubble\'s place', () => {
  const mine = user('msg_client', { optimistic: true, created: 0 }), native = user('abcd1234', { created: 900 });
  expect(shown([mine, native], { msg_client: text('msg_client', 'Reply with only ok.'), abcd1234: text('abcd1234', 'Reply with only ok.') }))
    .toEqual(['abcd1234']);
});

test('counterexamples: another text, an earlier message of the same text, and no native entry yet all keep the optimistic bubble', () => {
  const a = user('msg_a', { optimistic: true, created: 0 }), other = user('n1', { created: 900 });
  expect(shown([a, other], { msg_a: text('msg_a', 'hello'), n1: text('n1', 'something else') })).toEqual(['msg_a', 'n1']);
  const b = user('msg_b', { optimistic: true, created: 0 }), saved = user('n2', { created: -120_000 });
  expect(shown([saved, b], { msg_b: text('msg_b', 'same'), n2: text('n2', 'same') })).toEqual(['n2', 'msg_b']);
  const c = user('msg_c', { optimistic: true, created: 0 });
  expect(shown([c], { msg_c: text('msg_c', 'alone') })).toEqual(['msg_c']);
});
