import { expect, test } from 'bun:test';
import { act } from 'react';
import { CHECK, CONTINUE, deadlineChat, target } from './230-resume-deadline-chat.fixture';
import { operation, pageReply } from './230-resume-deadline-http.fixture';
import { loaded, recover } from './230-resume-deadline-recovery.helper';

test('new Check queues history before releasing independent partial page across remount', async () => {
  const f = await deadlineChat(120_000);
  try {
    const old = await f.page.take(), release = await old.partial(pageReply(true));
    await f.settle(() => f.buttons().includes(CONTINUE));
    console.info('order: initial partial page held');
    await f.click(CONTINUE);
    const post = await f.post.take(), requestId = f.requestId(post); post.lose();
    await f.settle(() => f.status()?.status === 'unknown');
    console.info('order: one lost POST, unknown');
    await f.rowUnavailable();
    expect(f.status()).toMatchObject({ status: 'unknown', requestId });
    expect(f.banner()).not.toBeNull(); expect(f.composer()).toBeNull(); expect(f.buttons()).toContain(CHECK);
    console.info('order: unknown recovery survives authoritative unavailable row');
    await f.remount(); await f.click(CHECK);
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready', requestId)] }));
    await f.settle(() => f.status()?.status === 'starting');
    console.info('order: ready list observed');
    await act(async () => release());
    console.info('order: partial page released');
    const fresh = await f.page.take();
    expect(f.banner()).not.toBeNull(); expect(f.composer()).toBeNull();
    fresh.reply(pageReply()); await f.settle(() => f.status() === undefined);
    console.info('order: writable page accepted');
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.banner()).toBeNull(); expect(f.composer()).not.toBeNull();
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(2);
  } finally { console.info('order: closing'); await f.close(); }
}, 10_000);

test('failed operation GET becomes unknown immediately and failed list never becomes checked-empty', async () => {
  const f = await deadlineChat();
  try {
    await loaded(f); await f.click(CONTINUE);
    const post = await f.post.take(), requestId = f.requestId(post);
    post.reply(Response.json({ nativeCreation: operation('starting', requestId) }, { status: 202 }));
    (await f.read.take()).reply(Response.json({ message: 'Private operation read failed' }, { status: 503 }));
    await f.settle(() => f.status()?.status === 'unknown');
    expect(f.status()).toMatchObject({ status: 'unknown', requestId, operationId: operation('starting').operationId });
    await f.rowUnavailable();
    expect(f.banner()).not.toBeNull(); expect(f.composer()).toBeNull(); expect(f.buttons()).toContain(CHECK);
    await f.click(CHECK);
    (await f.list.take()).reply(Response.json({ message: 'Private list failed' }, { status: 503 }));
    await f.settle(() => f.requests.filter(request => request.url.pathname === '/api/session/creation').every(request => request.responded));
    await act(async () => { await Promise.resolve(); });
    const value = f.status();
    expect(value?.status === 'unknown' ? value.checked : undefined).toBeUndefined();
    await recover(f, requestId);
  } finally { await f.close(); }
}, 10_000);
