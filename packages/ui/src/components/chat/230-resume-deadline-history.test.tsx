import { expect, test } from 'bun:test';
import { act } from 'react';
import { CHECK, CONTINUE, deadlineChat, target } from './230-resume-deadline-chat.fixture';
import { operation, pageReply } from './230-resume-deadline-http.fixture';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Existing createRuntimeOpencodeClient.requestTimeoutMs seam only. The real loader SDK read lives120s,
// so the production75s Continue observation expires first. No timer replacement or loader mock.
test('queued history observation expires without cancelling its independent read; newer check owns fresh accepted page', async () => {
  const f = await deadlineChat(120_000);
  try {
    const oldPage = await f.page.take();
    const releaseOld = await oldPage.partial(pageReply(true));
    await f.settle(() => f.buttons().includes(CONTINUE));
    await f.click(CONTINUE); const post = await f.post.take(), requestId = f.requestId(post);
    post.reply(Response.json({ nativeCreation: operation('ready', requestId) }, { status: 202 }));
    await f.settle(() => { const value = f.status(); return value?.status === 'starting' && value.operationId === operation('ready').operationId; });
    await f.waitDeadline();
    expect(f.status()).toMatchObject({ status: 'unknown', requestId, operationId: operation('ready').operationId });
    expect(f.loader.getSnapshot(target).status).toBe('loading');
    expect(oldPage.responded).toBe(false);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(1);
    expect(f.buttons()).toContain(CHECK); await f.remount(); expect(f.buttons()).toContain(CHECK);
    await f.click(CHECK);
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready', requestId)] }));
    // The new Check owns the queued freshness demand before the independent old page completes.
    // Otherwise its list can arrive after the queued refresh starts and correctly demand a third page.
    await f.settle(() => f.status()?.status === 'starting');
    await f.rowUnavailable();
    await act(async () => releaseOld());
    const fresh = await f.page.take();
    expect(f.status()).toMatchObject({ status: 'starting', requestId, operationId: operation('ready').operationId });
    expect(f.banner()).not.toBeNull(); expect(f.composer()).toBeNull();
    fresh.reply(pageReply()); await f.settle(() => f.status() === undefined);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.loader.getAcceptedOrdinaryView(target, getRuntimeKey())).toBe(`ov2_${'a'.repeat(64)}`);
    expect(f.banner()).toBeNull(); expect(f.composer()).not.toBeNull();
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(2);
  } finally { await f.close(); }
}, 95_000);
