import { expect, test } from 'bun:test';
import type { AssistantMessage, Message, UserMessage } from '@opencode-ai/sdk/v2';
import { lastRealMessage } from '@/components/chat/message/systemNote';

// openchamber#224 review: the session assist targets the session's last message. A voice call note appended after the
// agent's reply (smarty-voice-state, clientRole 'system-note') must not become that target, or the UI rejects the assist.
const user: UserMessage = { id: 'u1', sessionID: 's', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
const reply: AssistantMessage = { id: 'a1', sessionID: 's', role: 'assistant', time: { created: 2, completed: 3 }, parentID: 'u1',
  modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
const note: Message = { ...reply, id: 'n1', time: { created: 4, completed: 4 }, providerID: 'pi-native', modelID: 'system-note',
  ...{ clientRole: 'system-note' } };

test('the assist\'s last message skips voice call notes: the reply before a note is the target', () => {
  expect(lastRealMessage([user, reply, note])?.id).toBe('a1');
  expect(lastRealMessage([user, reply, note, { ...note, id: 'n2' }])?.id).toBe('a1');
  expect(lastRealMessage([user, reply])?.id).toBe('a1'); // No note: unchanged.
  expect(lastRealMessage([note])).toBeNull();
  expect(lastRealMessage(undefined)).toBeNull();
});
