import './native-test-network';
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { subscribeDirectorySessionMessages } from './child-store';
import { optimisticMessageRecords } from './unsaved';
import { author, renamed, record, target, fixture, type Kind } from './675-stale-read.fixture';

for (const revision of [undefined, 7]) {
  for (const kind of ['initial', 'tail', 'older', 'window', 'reset'] satisfies Kind[]) {
    test(`held ${kind} cannot erase a newer live author, revision ${revision ?? 'absent'}`, async () => {
      const f = fixture(), unlabelled = record('msg_675', undefined, revision);
      const shadow = record('msg_675', undefined, revision);
      shadow.info.agent = 'optimistic-agent';
      f.loader.optimisticAdd({ ...target, message: shadow.info, parts: shadow.parts });
      f.live(unlabelled.info);
      expect(optimisticMessageRecords.has(f.shown()[0])).toBe(false);
      if (kind !== 'initial') await f.load([unlabelled], 'initial', { 'x-next-cursor': 'older-675' });
      const read = await f.start([unlabelled], kind);
      f.live(record('msg_675', author, revision).info);
      const live = f.shown()[0];
      expect(f.label()).toContain(author.name);
      read.release(); await read.done;
      expect(f.shown()).toHaveLength(1);
      expect(f.shown()[0]).toBe(live);
      expect(f.label()).toContain(author.name);
      expect(f.reads).toHaveLength(kind === 'initial' ? 1 : 2);
      // The opposite ordering must still adopt author-only history after authorless live promotion.
      f.live(unlabelled.info);
      await f.load([record('msg_675', renamed, revision)]);
      expect(f.label()).toContain(renamed.name);
      expect(f.shown()).toHaveLength(1);
      expect(f.reads).toHaveLength(kind === 'initial' ? 2 : 3);
    });
  }
}

for (const human of [undefined, renamed]) {
  test(`held page cannot undo live author ${human ? 'change' : 'removal'}`, async () => {
    const f = fixture();
    await f.load([record('msg_675', author)], 'initial');
    const read = await f.start([record('msg_675', author)]);
    f.live(record('msg_675', human).info);
    const live = f.shown()[0];
    read.release(); await read.done;
    expect(f.shown()[0]).toBe(live);
    expect(trustedHumanAuthor(f.shown()[0])).toEqual(human);
    expect(f.label()).toBe(human ? renderToStaticMarkup(createElement(HumanAuthor, { info: live })) : '');
  });
}

test('a higher authoritative page revision wins over an intervening live author mutation', async () => {
  const f = fixture();
  await f.load([record('msg_675', undefined, 7)], 'initial');
  const read = await f.start([record('msg_675', renamed, 9)]);
  f.live(record('msg_675', author, 8).info);
  read.release(); await read.done;
  expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
  expect(f.label()).toContain(renamed.name);
  expect(f.reads).toHaveLength(2);
});

test('a same-ID live row first arriving during an initial read keeps its author', async () => {
  const f = fixture(), read = await f.start([record()], 'initial');
  f.live(record('msg_675', author).info);
  read.release(); await read.done;
  expect(f.label()).toContain(author.name);
  expect(f.reads).toHaveLength(1);
});

test('streaming and sibling events do not block unchanged IDs, even with identical text', async () => {
  const f = fixture();
  await f.load([record(), record('msg_sibling', undefined, undefined, 102)], 'initial');
  f.store.setState({ part: { ...f.store.getState().part, msg_stream: [] } });
  const reply = { id: 'msg_stream', sessionID: target.sessionID, role: 'assistant', parentID: 'msg_675', time: { created: 103 },
    agent: 'build', mode: 'build', providerID: 'test', modelID: 'test', path: { cwd: target.directory, root: target.directory },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies Message;
  f.live(reply);
  const read = await f.start([record('msg_675', author), record('msg_sibling', undefined, undefined, 102)]);
  f.live(record('msg_sibling', renamed, undefined, 102).info);
  f.event({ id: 'evt_part', type: 'message.part.updated', properties: { sessionID: target.sessionID, time: 103,
    part: { id: 'prt_stream', messageID: 'msg_stream', sessionID: target.sessionID, type: 'text', text: '' } } });
  for (let i = 0; i < 100; i++) {
    f.event({ id: `evt_delta_${i}`, type: 'message.part.delta', properties: { sessionID: target.sessionID,
      messageID: 'msg_stream', partID: 'prt_stream', field: 'text', delta: `${i}` } });
    f.live({ ...reply, cost: i + 1 });
  }
  const sibling = f.shown()[1];
  read.release(); await read.done;
  expect(f.shown().map(info => info.id)).toEqual(['msg_675', 'msg_sibling', 'msg_stream']);
  expect(f.label()).toContain(author.name);
  expect(f.shown()[1]).toBe(sibling);
  expect(f.label('msg_sibling')).toContain(renamed.name);
  expect(f.reads).toHaveLength(2);
});

test('a same-ID non-metadata update does not block an author-only page', async () => {
  const f = fixture();
  await f.load([record()], 'initial');
  const read = await f.start([record('msg_675', author)]);
  f.live({ ...record().info, agent: 'live-agent' });
  read.release(); await read.done;
  expect(f.label()).toContain(author.name);
  expect(f.shown()[0].agent).toBe('live-agent');
  expect(f.reads).toHaveLength(2);
});

test('equivalent pages after a fenced read preserve references and emit no message notifications', async () => {
  const f = fixture();
  await f.load([record()], 'initial');
  const read = await f.start([record()]);
  f.live(record('msg_675', author).info);
  read.release(); await read.done;
  const before = f.store.getState(), bucket = f.shown();
  let notifications = 0;
  const unsubscribe = subscribeDirectorySessionMessages(f.store, target.sessionID, () => { notifications++; });
  try {
    for (let i = 0; i < 20; i++) await f.load([record('msg_675', { name: author.name, subject: author.subject, issuer: author.issuer, version: 1 })]);
    expect(f.shown()).toBe(bucket);
    expect(f.store.getState().message).toBe(before.message);
    expect(f.store.getState().part).toBe(before.part);
    expect(notifications).toBe(0);
    expect(f.reads).toHaveLength(22);
  } finally { unsubscribe(); }
});
