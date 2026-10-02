import { expect, test } from 'bun:test';
import { resetRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { deferred, operation, pageReply, stateReply, type Receipt } from './365-recovery-http.fixture';

for (const boundary of ['post', 'list', 'poll', 'read', 'history'] as const)
  for (const retirement of ['auth', 'transport', 'runtime'] as const)
    test(`${retirement} retirement at ${boundary} await retains unknown and never dispatches a successor mutation`, async () => {
      const f = await recoveryFixture();
      try {
        let pending = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
        const post = await f.post.take();
        let held: Receipt = post;
        const polling = deferred<void>(), releasePoll = deferred<void>();
        resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
        if (boundary === 'list') {
          post.lose(); await f.settle(pending);
          pending = f.start(() => resume.checkContinue(target.directory, target.sessionID));
          held = await f.list.take();
        } else if (boundary === 'history') {
          post.reply(stateReply('ready')); held = await f.page.take();
        } else if (boundary === 'read') {
          resume.resumeTiming.poll = async () => {};
          post.reply(stateReply('starting')); held = await f.read.take();
        } else if (boundary === 'poll') {
          post.reply(stateReply('starting')); await f.settle(polling.promise);
        }
        if (retirement === 'auth') resetRuntimeAuthGeneration();
        else if (retirement === 'transport') configureRuntimeUrlResolver({ apiBaseUrl: f.base });
        else {
          Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: `${f.base}/retired`, configurable: true });
          configureRuntimeUrlResolver({ apiBaseUrl: `${f.base}/retired` });
        }
        if (boundary === 'poll') releasePoll.resolve();
        else held.reply(boundary === 'list' ? Response.json({ nativeCreations: [] })
          : boundary === 'history' ? pageReply() : stateReply('ready'));
        await f.settle(pending);
        // Restore display of the originating runtime. Returning to equal URL bytes never revives old request authority.
        if (retirement === 'runtime') {
          Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: f.base, configurable: true });
          configureRuntimeUrlResolver({ apiBaseUrl: f.base }); await f.render();
        }
        expect(f.status()).toMatchObject({ status: 'unknown', requestId: f.requestId(post) });
        const current = f.status();
        expect(current?.status === 'unknown' ? current.checked : undefined).toBeUndefined();
        await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
        expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
        if (boundary !== 'history') expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
        if (boundary === 'poll') expect(f.requests.filter(request => request.url.pathname.endsWith(operation('ready').operationId))).toHaveLength(0);
      } finally { await f.close(); }
    });

test('a ready operation for a foreign directory cannot authorize this tuple or load its history', async () => {
  const f = await recoveryFixture();
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready', undefined, '/foreign'));
    await f.settle(continuing);
    expect(f.status()).toMatchObject({ status: 'unknown', operationId: operation('ready').operationId });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
  } finally { await f.close(); }
});

test('equal session ID in another directory cannot clear the original pending owner or change dispatch bytes', async () => {
  const f = await recoveryFixture();
  try {
    const original = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const ownPost = await f.post.take();
    const otherDirectory = '/365 recovery/other project';
    const other = f.start(() => resume.continueEndedSession(otherDirectory, target.sessionID));
    const otherPost = await f.post.take(); otherPost.reply(stateReply('ready', f.requestId(otherPost), otherDirectory));
    const otherPage = await f.page.take();
    expect(otherPage.url.searchParams.get('directory')).toBe(otherDirectory);
    otherPage.reply(pageReply()); await f.settle(other);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(ownPost) });
    expect(otherPost.url.searchParams.get('directory')).toBe(otherDirectory);
    expect(otherPost.body).toBe(JSON.stringify({ sessionID: target.sessionID, clientRequestId: f.requestId(otherPost) }));
    ownPost.reply(stateReply('ready'));
    const ownPage = await f.page.take(); expect(ownPage.url.searchParams.get('directory')).toBe(target.directory);
    ownPage.reply(pageReply()); await f.settle(original);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});
