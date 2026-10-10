import './native-test-network';
import { expect, test } from 'bun:test';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { author, renamed, record, target, fixture, type Kind } from './675-stale-read.fixture';
import { materializeSessionSnapshots } from './materialization';
import { materializeConfirmedSendRecords } from './session-actions';
import { sessionMessageEventCount } from './event-reducer';
import { messageMetadataRevision } from './unsaved';

for (const revision of [undefined, 7]) {
  for (const kind of ['initial', 'tail', 'older', 'window', 'reset'] satisfies Kind[]) {
    test(`metadata ABA fences held ${kind}, revision ${revision ?? 'absent'}, reusing payloads`, async () => {
      const f = fixture(), a = record('msg_675', author, revision), b = record('msg_675', renamed, revision);
      f.live(a.info);
      if (kind !== 'initial') await f.load([a], 'initial', { 'x-next-cursor': 'older-675' });
      const baseline = f.shown()[0], read = await f.start([b], kind);
      f.live(b.info);
      expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
      f.live(a.info); // The exact A object already supplied before dispatch, not a fresh decoded replacement.
      const current = f.shown()[0];
      expect(trustedHumanAuthor(current)).toEqual(trustedHumanAuthor(baseline));
      read.release(); await read.done;
      expect(f.shown()).toHaveLength(1);
      expect(f.shown()[0]).toBe(current);
      expect(f.label()).toContain(author.name);
      expect(f.reads).toHaveLength(kind === 'initial' ? 1 : 2);
      // A newly dispatched page has fresh read authority and can change the same author normally.
      await f.load([b]);
      expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
      expect(f.reads).toHaveLength(kind === 'initial' ? 2 : 3);
    });
  }
}

for (const publish of ['materialization', 'send confirmation'] as const) {
  test(`${publish} metadata ABA cannot be replaced by a held page`, async () => {
    const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
    await f.load([a], 'initial');
    const read = await f.start([b]);
    const apply = (row: ReturnType<typeof record>) => {
      if (publish === 'send confirmation') {
        materializeConfirmedSendRecords(f.store, target.sessionID, row.info.id, [row]);
      } else {
        const result = materializeSessionSnapshots(f.store.getState(), target.sessionID, [row]);
        f.store.setState({ message: result.message, part: result.part });
      }
    };
    apply(b); apply(a);
    const current = f.shown()[0];
    expect(trustedHumanAuthor(current)).toEqual(author);
    read.release(); await read.done;
    expect(f.shown()[0]).toBe(current);
    expect(f.label()).toContain(author.name);
    expect(f.reads).toHaveLength(2);
  });
}

test('a pending window preserves metadata mutations published by later tail pages', async () => {
  const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
  await f.load([a], 'initial');
  const read = await f.start([b], 'window');
  await f.load([b]); await f.load([a]);
  const current = f.shown()[0];
  read.release(); await read.done;
  expect(f.shown()[0]).toBe(current);
  expect(f.label()).toContain(author.name);
  expect(f.reads).toHaveLength(4);
});

test('same-ID non-metadata ABA advances the event count without fencing a fresh author page', async () => {
  const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
  await f.load([a], 'initial');
  const read = await f.start([b]), before = sessionMessageEventCount(target.sessionID);
  f.live({ ...a.info, agent: 'temporarily changed' });
  f.live(a.info);
  expect(sessionMessageEventCount(target.sessionID)).toBe(before + 2);
  read.release(); await read.done;
  expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
  expect(f.shown()[0].agent).toBe('build');
  expect(f.reads).toHaveLength(2);
});

test('reusing an older published A object after B cannot lend its cached revision to the current row', async () => {
  const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
  await f.load([a], 'initial');
  const cached = f.shown()[0], read = await f.start([b]);
  f.live(b.info); f.live(cached);
  const current = f.shown()[0];
  expect(current).not.toBe(cached);
  read.release(); await read.done;
  expect(f.shown()[0]).toBe(current);
  expect(f.label()).toContain(author.name);
  expect(f.reads).toHaveLength(2);
});

test('equivalent confirmation and unrelated same-ID metadata do not create false read authority', async () => {
  const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
  await f.load([a], 'initial');
  const read = await f.start([b]), revision = messageMetadataRevision();
  materializeConfirmedSendRecords(f.store, target.sessionID, a.info.id, [a]);
  const unrelated = { ...a.info, agent: 'live-agent', metadata: { ...a.info.metadata, unrelated: 'retained live value' } };
  f.live(unrelated);
  expect(messageMetadataRevision()).toBe(revision);
  read.release(); await read.done;
  expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
  expect(f.shown()[0].agent).toBe('live-agent');
  expect(f.reads).toHaveLength(2);
});

test('equivalent reset does not count an existing row as a new metadata mutation', async () => {
  const f = fixture(), a = record('msg_675', author);
  await f.load([a], 'initial');
  const revision = messageMetadataRevision();
  await f.load([a], 'reset');
  expect(messageMetadataRevision()).toBe(revision);
  expect(f.label()).toContain(author.name);
  expect(f.reads).toHaveLength(2);
});

for (const publish of ['materialization', 'send confirmation'] as const) {
  test(`${publish} of a new row during a held read keeps its author`, async () => {
    const f = fixture(), a = record('msg_675', author), b = record('msg_675', renamed);
    const read = await f.start([b], 'initial');
    if (publish === 'send confirmation') materializeConfirmedSendRecords(f.store, target.sessionID, a.info.id, [a]);
    else {
      const result = materializeSessionSnapshots(f.store.getState(), target.sessionID, [a]);
      f.store.setState({ message: result.message, part: result.part });
    }
    const current = f.shown()[0];
    read.release(); await read.done;
    expect(f.shown()[0]).toBe(current);
    expect(f.label()).toContain(author.name);
    expect(f.reads).toHaveLength(1);
  });
}
