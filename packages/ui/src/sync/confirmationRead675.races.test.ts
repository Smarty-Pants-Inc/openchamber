import './native-test-network';
import { expect, test } from 'bun:test';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { confirmationFixture, author, renamed, record } from './confirmationRead675.fixture';

for (const revision of [undefined, 7]) {
  for (const scenario of ['author addition', 'author change', 'author removal', 'ABA', 'first arrival'] as const) {
    test(`held confirmation GET preserves newer ${scenario}, producer revision ${revision ?? 'absent'}`, async () => {
      const f = confirmationFixture();
      const a = record('msg_675', author, revision), b = record('msg_675', renamed, revision), unlabelled = record('msg_675', undefined, revision);
      const held = f.enqueue(scenario === 'author addition' || scenario === 'first arrival' ? [unlabelled] : [b]);
      const send = await f.start();
      if (scenario !== 'first arrival') f.live(scenario === 'author addition' ? unlabelled.info : scenario === 'author change' ? b.info : a.info);
      send.failReceipt(); await held.dispatched;
      if (scenario === 'ABA') { f.live(b.info); f.live(a.info); }
      else f.live(scenario === 'author removal' ? unlabelled.info : a.info);
      const current = f.shown()[0];
      held.release(); expect(await send.done).toBeUndefined();
      expect(f.shown()).toHaveLength(1);
      expect(f.shown()[0]).toBe(current);
      expect(trustedHumanAuthor(f.shown()[0])).toEqual(scenario === 'author removal' ? undefined : author);
      if (scenario !== 'author removal') expect(f.label()).toContain(author.name);
      expect(f.counts).toEqual({ sends: 1, confirms: 1, removes: 0 });
      expect(f.posts).toHaveLength(1); expect(f.reads).toHaveLength(1);
      expect(new URL(f.reads[0].url).searchParams.get('limit')).toBe('30');
    });
  }
  for (const transition of ['add', 'change', 'remove'] as const) {
    test(`fresh confirmation GET can ${transition} author, producer revision ${revision ?? 'absent'}`, async () => {
      const f = confirmationFixture();
      const before = record('msg_675', transition === 'add' ? undefined : author, revision);
      const after = record('msg_675', transition === 'remove' ? undefined : renamed, revision);
      const read = f.enqueue([after]), send = await f.start();
      // Promotion happens before this confirmation GET, so its page remains authoritative.
      f.live(before.info); send.failReceipt(); await read.dispatched;
      read.release(); expect(await send.done).toBeUndefined();
      expect(trustedHumanAuthor(f.shown()[0])).toEqual(transition === 'remove' ? undefined : renamed);
      expect(f.counts).toEqual({ sends: 1, confirms: 1, removes: 0 });
      expect(f.reads).toHaveLength(1);
    });
  }
}

for (const pageRevision of [7, 9]) {
  test(`paired producer precedence: confirmation ${pageRevision} versus live 8`, async () => {
    const f = confirmationFixture(), read = f.enqueue([record('msg_675', renamed, pageRevision)]), send = await f.start();
    f.live(record('msg_675', undefined, 8).info);
    send.failReceipt(); await read.dispatched;
    f.live(record('msg_675', author, 8).info);
    read.release(); expect(await send.done).toBeUndefined();
    expect(trustedHumanAuthor(f.shown()[0])).toEqual(pageRevision === 9 ? renamed : author);
    expect(f.reads).toHaveLength(1);
  });
}

test('confirmation retry captures a new numeric baseline after the failed actual GET', async () => {
  const f = confirmationFixture(), first = f.enqueue([], 503), second = f.enqueue([record('msg_675', renamed, 7)]);
  const send = await f.start(); f.live(record('msg_675', undefined, 7).info);
  send.failReceipt(); await first.dispatched;
  f.live(record('msg_675', author, 7).info); first.release();
  await second.dispatched; second.release(); expect(await send.done).toBeUndefined();
  expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
  expect(f.reads).toHaveLength(2); expect(f.posts).toHaveLength(1);
  expect(f.counts).toEqual({ sends: 1, confirms: 1, removes: 0 });
});
