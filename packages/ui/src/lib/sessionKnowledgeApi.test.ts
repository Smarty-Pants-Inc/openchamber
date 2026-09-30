import { expect, mock, test } from 'bun:test';

// smarty-code#827: a send never waits long for its knowledge block (under load the read took seconds, before every
// POST). Past the bound it goes without it (EMPTY), and the server still owes the block to the next message.
let answer: (init: RequestInit) => Promise<Response> = async () => Response.json({ text: 'notes', signature: 's1' });
mock.module('./runtime-fetch', () => ({ runtimeFetch: (_url: string, init: RequestInit = {}) => answer(init) }));
const { fetchSessionKnowledge, SESSION_KNOWLEDGE_WAIT_MS } = await import('./sessionKnowledgeApi');

test('a knowledge read that does not answer in time gives up: the message goes without the block', async () => {
  SESSION_KNOWLEDGE_WAIT_MS.value = 100;
  answer = (init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))); });
  const started = Date.now();
  expect(await fetchSessionKnowledge('/repo', 's')).toEqual({ text: '', signature: '' });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('an answer in time is used as before', async () => {
  SESSION_KNOWLEDGE_WAIT_MS.value = 1_500;
  answer = async () => Response.json({ text: 'notes', signature: 's1' });
  expect(await fetchSessionKnowledge('/repo', 's')).toEqual({ text: 'notes', signature: 's1' });
});
