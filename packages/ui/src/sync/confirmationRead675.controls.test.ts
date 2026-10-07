import './native-test-network';
import { expect, test } from 'bun:test';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { confirmationFixture, author, renamed, record, target } from './confirmationRead675.fixture';
import { messageMetadataRevision, isUnsaved } from './unsaved';

for (const revision of [undefined, 7]) {
  test(`held confirmation GET protects sibling author and save state, revision ${revision ?? 'absent'}`, async () => {
    const f = confirmationFixture(), sent = record(), old = record('msg_sibling', renamed, revision);
    const oldUnsaved = { ...old, info: { ...old.info, metadata: { ...old.info.metadata, smartyCodeUnsaved: true } } };
    const fresh = record('msg_sibling', author, revision);
    const read = f.enqueue([sent, oldUnsaved]), send = await f.start();
    f.live(sent.info); f.live(oldUnsaved.info); send.failReceipt(); await read.dispatched;
    f.live(fresh.info); const current = f.shown().find(info => info.id === fresh.info.id);
    read.release(); expect(await send.done).toBeUndefined();
    const sibling = f.shown().find(info => info.id === fresh.info.id);
    expect(sibling).toBe(current); expect(trustedHumanAuthor(sibling)).toEqual(author); expect(isUnsaved(sibling)).toBe(false);
    expect(f.shown()).toHaveLength(2); expect(f.counts).toEqual({ sends: 1, confirms: 1, removes: 0 });
    expect(f.reads).toHaveLength(1); expect(f.posts).toHaveLength(1);
  });
  test(`fresh confirmation GET adopts sibling author and save state, revision ${revision ?? 'absent'}`, async () => {
    const f = confirmationFixture(), sent = record(), old = record('msg_sibling', author, revision);
    const fresh = record('msg_sibling', renamed, revision);
    const freshUnsaved = { ...fresh, info: { ...fresh.info, metadata: { ...fresh.info.metadata, smartyCodeUnsaved: true } } };
    const read = f.enqueue([sent, freshUnsaved]), send = await f.start();
    f.live(sent.info); f.live(old.info); send.failReceipt(); await read.dispatched;
    read.release(); expect(await send.done).toBeUndefined();
    const sibling = f.shown().find(info => info.id === fresh.info.id);
    expect(trustedHumanAuthor(sibling)).toEqual(renamed); expect(isUnsaved(sibling)).toBe(true);
    expect(f.shown()).toHaveLength(2); expect(f.reads).toHaveLength(1);
  });
}

test('equivalent confirmation cannot fence an already pending loader page', async () => {
  const f = confirmationFixture(), a = record('msg_675', author, 7), b = record('msg_675', renamed, 7);
  const send = await f.start(); f.live(a.info);
  const older = f.enqueue([b]), loading = f.loader.ensure(target);
  await older.dispatched;
  const confirm = f.enqueue([a]), before = messageMetadataRevision();
  send.failReceipt(); await confirm.dispatched; confirm.release(); expect(await send.done).toBeUndefined();
  expect(messageMetadataRevision()).toBe(before);
  older.release(); await loading;
  expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
  expect(f.reads).toHaveLength(2); expect(f.posts).toHaveLength(1);
});

test('confirmation sanitizes diff snapshots and filters parts without losing read freshness', async () => {
  const f = confirmationFixture(), a = record('msg_675', author, 7), b = record('msg_675', renamed, 7);
  const withDiff = { ...b, info: { ...b.info, summary: { title: '', body: '', diffs: [
    { file: 'example.ts', additions: 1, deletions: 0, before: 'large old snapshot', after: 'large new snapshot' },
  ] } }, parts: [...b.parts, { id: 'prt_skip', messageID: b.info.id, sessionID: target.sessionID, type: 'step-start' as const }] };
  const read = f.enqueue([withDiff]), send = await f.start();
  f.live(b.info); send.failReceipt(); await read.dispatched; f.live(a.info);
  const current = f.shown()[0]; read.release(); expect(await send.done).toBeUndefined();
  expect(f.shown()[0]).toBe(current); expect(trustedHumanAuthor(f.shown()[0])).toEqual(author);
  expect(f.store.getState().part.msg_675).toEqual(a.parts);
  expect(messageMetadataRevision()).toBeGreaterThan(0);
});

test('fresh diff-bearing confirmation publishes only sanitized info', async () => {
  const f = confirmationFixture(), a = record('msg_675', author, 7);
  const withDiff = { ...a, info: { ...a.info, summary: { title: '', body: '', diffs: [
    { file: 'example.ts', additions: 1, deletions: 0, before: 'old snapshot', after: 'new snapshot' },
  ] } } };
  const read = f.enqueue([withDiff]), send = await f.start();
  send.failReceipt(); await read.dispatched; read.release(); expect(await send.done).toBeUndefined();
  expect(f.shown()[0]).toMatchObject({ summary: { diffs: [{ file: 'example.ts', additions: 1, deletions: 0 }] } });
  expect(JSON.stringify(f.shown()[0])).not.toContain('snapshot'); expect(f.label()).toContain(author.name);
});

test('three bounded confirmation reads with same-text other IDs roll back without replay', async () => {
  const f = confirmationFixture();
  const attempts = [f.enqueue([record('msg_other')]), f.enqueue([record('msg_other')]), f.enqueue([record('msg_other')])];
  const send = await f.start(); send.failReceipt();
  for (const read of attempts) { await read.dispatched; read.release(); }
  expect(await send.done).toBeInstanceOf(Error);
  expect(f.shown()).toHaveLength(0); expect(f.store.getState().part.msg_675).toBeUndefined();
  expect(f.counts).toEqual({ sends: 1, confirms: 0, removes: 1 });
  expect(f.reads).toHaveLength(3); expect(f.posts).toHaveLength(1);
});

test('three failed confirmation GETs preserve rollback semantics, never authoritative empty success', async () => {
  const f = confirmationFixture();
  const attempts = [f.enqueue([], 503), f.enqueue([], 503), f.enqueue([], 503)];
  const send = await f.start(); send.failReceipt();
  for (const read of attempts) { await read.dispatched; read.release(); }
  expect(await send.done).toBeInstanceOf(Error);
  expect(f.counts).toEqual({ sends: 1, confirms: 0, removes: 1 });
  expect(f.shown()).toHaveLength(0); expect(f.reads).toHaveLength(3); expect(f.posts).toHaveLength(1);
});
