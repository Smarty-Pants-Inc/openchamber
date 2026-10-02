import { expect, test } from 'bun:test';
import { act } from 'react';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { operation, pageReply, stateReply } from './365-recovery-http.fixture';

for (const failedFresh of [false, true]) test(`ready queues one fresh loader read behind old readonly work, fresh failure=${failedFresh}`, async () => {
  const f = await recoveryFixture();
  try {
    const old = f.loader.ensure(target, { reason: 'navigation' });
    const oldPage = await f.page.take();
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const post = await f.post.take(); post.reply(stateReply('ready', f.requestId(post)));
    // Operation response precedes the old readonly page. The old page may commit but cannot finish Continue.
    await f.waitForStatus(value => value?.status === 'starting' && value.operationId === operation('ready').operationId);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(1);
    oldPage.reply(pageReply(true)); await old;
    const fresh = await Promise.race([f.raw.page.take(), continuing.then(() => null)]);
    expect(fresh).not.toBeNull();
    if (!fresh) throw new Error('Continue joined the old page instead of queuing an authoritative read');
    fresh.reply(failedFresh ? new Response('bad page', { status: 400 }) : pageReply());
    await f.settle(continuing);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(2);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    if (failedFresh) {
      expect(f.status()).toMatchObject({ status: 'unknown', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      const current = f.status();
      expect(current?.status === 'unknown' ? current.checked : undefined).toBeUndefined();
      expect(f.loader.getSnapshot(target).status).toBe('error');
      const checking = f.start(() => resume.checkContinue(target.directory, target.sessionID));
      const list = await f.list.take(); list.reply(Response.json({ nativeCreations: [
        operation('ready', f.requestId(post)),
      ] }));
      (await f.page.take()).reply(pageReply()); await f.settle(checking);
      expect(f.status()).toBeUndefined();
      expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    } else {
      expect(f.status()).toBeUndefined();
      expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
      expect(f.dom.container.textContent).toBe('clear');
    }
  } finally { await f.close(); }
}, 5000);

test('older no-match CHECK2 cannot replace newer CONTINUE2 or allow CONTINUE3 POST', async () => {
  const f = await recoveryFixture();
  try {
    const first = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const firstPost = await f.post.take(); firstPost.lose(); await f.settle(first);
    const check1 = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).reply(Response.json({ nativeCreations: [] })); await f.settle(check1);
    expect(f.status()).toMatchObject({ status: 'unknown', checked: true });
    const check2 = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    const heldCheck = await f.list.take();
    const second = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const secondPost = await f.post.take();
    await act(async () => { await Promise.resolve(); });
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(secondPost) });
    heldCheck.reply(Response.json({ nativeCreations: [] })); await f.settle(check2);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(secondPost) });
    await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(2);
    secondPost.reply(stateReply('ready', f.requestId(secondPost)));
    (await f.page.take()).reply(pageReply()); await f.settle(second);
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(firstPost.body).toBe(JSON.stringify({ sessionID: target.sessionID, clientRequestId: f.requestId(firstPost) }));
    expect(secondPost.url.searchParams.get('directory')).toBe(target.directory);
  } finally { await f.close(); }
}, 5000);
