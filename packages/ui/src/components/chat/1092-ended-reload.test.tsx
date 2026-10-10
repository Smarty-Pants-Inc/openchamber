import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AssistantMessage, TextPart } from '@opencode-ai/sdk/v2';
import { mountedChat, target } from './365-mounted-chat.fixture';
import { pageReply } from './365-mounted-http.fixture';

type Mounted = Awaited<ReturnType<typeof mountedChat>>;
const messageGets = (f: Mounted) => f.requests.filter(request => request.method === 'GET'
  && request.url.pathname.endsWith(`/session/${target.sessionID}/message`)).length;
const bucket = (f: Mounted) => f.children.getChild(target.directory)?.getState().message[target.sessionID];
const parts = (f: Mounted, messageID: string) => f.children.getChild(target.directory)?.getState().part[messageID];
/** Rerenders the actual parent and gives its effects time to start a read, then counts message reads. */
async function rerenderQuietly(f: Mounted) {
  for (let turn = 0; turn < 3; turn++) await f.render();
  await act(async () => { await sleep(50); });
}

test('#1092 ended session with a pre-existing empty bucket reads its history once', async () => {
  const f = await mountedChat({ bucket: { message: [] } });
  try {
    // RED on the base: the empty bucket counts as renderable, so the actual ensure effect never runs.
    await f.settle(() => messageGets(f) > 0); expect(messageGets(f)).toBe(1);
    (await f.page.take()).reply(pageReply(true));
    await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(bucket(f)?.map(message => message.id)).toEqual(['msg_365']);
    expect(parts(f, 'msg_365')).toMatchObject([{ id: 'part_365', type: 'text', text: 'Preserved history' }]);
    await rerenderQuietly(f);
    expect(messageGets(f)).toBe(1);
  } finally { await f.close(); }
});

test('#1092 counterexample: a successful empty read stays resolved and is not read again on rerenders', async () => {
  const f = await mountedChat();
  try {
    await f.settle(() => messageGets(f) > 0); expect(messageGets(f)).toBe(1);
    (await f.page.take()).reply(Response.json([], { headers: { 'x-smarty-read-only': '1' } }));
    await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(bucket(f)).toEqual([]);
    await rerenderQuietly(f);
    expect(messageGets(f)).toBe(1);
  } finally { await f.close(); }
});

const streamed: AssistantMessage = { id: 'msg_stream', sessionID: target.sessionID, role: 'assistant', time: { created: 2 },
  parentID: 'msg_365', modelID: 'preserved-model', providerID: 'preserved-provider', mode: 'build', agent: 'build',
  path: { cwd: target.directory, root: target.directory }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
const streamedPart: TextPart = { id: 'part_stream', sessionID: target.sessionID, messageID: 'msg_stream', type: 'text', text: 'Streamed' };

test('#1092 a renderable stream-only bucket without resolved history reads exactly once', async () => {
  const f = await mountedChat({ bucket: { message: [streamed], part: { msg_stream: [streamedPart] } } });
  try {
    expect(f.loader.getSnapshot(target).resolved).toBe(false);
    await f.settle(() => messageGets(f) > 0); expect(messageGets(f)).toBe(1);
    (await f.page.take()).reply(pageReply(true));
    await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(bucket(f)?.map(message => message.id)).toContain('msg_365');
    expect(parts(f, 'msg_365')).toMatchObject([{ id: 'part_365', type: 'text', text: 'Preserved history' }]);
    await rerenderQuietly(f);
    expect(messageGets(f)).toBe(1);
  } finally { await f.close(); }
});
