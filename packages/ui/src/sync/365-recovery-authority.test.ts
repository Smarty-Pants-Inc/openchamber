import { expect, test } from 'bun:test';
import { act } from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { deferred, failureReply, operation, pageReply, stateReply } from './365-recovery-http.fixture';

for (const answer of ['ready', 'cancelled', 'refused', 'lost'] as const)
  test(`an older start ${answer} completion cannot publish into a newer same-tuple record`, async () => {
    const f = await recoveryFixture();
    try {
      const old = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
      const oldPost = await f.post.take();
      // Page retirement removes that owner. A new page's record with equal tuple bytes is not its cohort.
      act(() => resume.resetContinueForPage());
      const newer = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
      const newPost = await f.post.take();
      if (answer === 'lost') oldPost.lose();
      else oldPost.reply(answer === 'refused' ? failureReply(409) : stateReply(answer));
      await f.settle(old);
      expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(newPost) });
      expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
      await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
      expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(2);
      newPost.reply(stateReply('ready'));
      (await f.page.take()).reply(pageReply()); await f.settle(newer);
      expect(f.status()).toBeUndefined();
    } finally { await f.close(); }
  });

test('an older loader completion cannot clear a newer same-tuple start', async () => {
  const f = await recoveryFixture();
  try {
    const old = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    const oldPage = await f.page.take();
    act(() => resume.resetContinueForPage());
    const newer = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const newPost = await f.post.take();
    oldPage.reply(pageReply()); await f.settle(old);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(newPost) });
    await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(2);
    newPost.reply(stateReply('ready'));
    (await f.page.take()).reply(pageReply()); await f.settle(newer);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});

for (const failedOld of [false, true]) test(`newer Check cohort owns follow, older check failure=${failedOld}`, async () => {
  const f = await recoveryFixture();
  try {
    const lost = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const post = await f.post.take(); post.lose(); await f.settle(lost);
    const oldCheck = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    const oldList = await f.list.take();
    const polling = deferred<void>(), releasePoll = deferred<void>();
    resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
    const newCheck = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('starting', f.requestId(post))] }));
    await f.settle(polling.promise);
    if (failedOld) oldList.lose(); else oldList.reply(Response.json({ nativeCreations: [] }));
    await f.settle(oldCheck);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(post), operationId: operation('ready').operationId });
    releasePoll.resolve();
    (await f.read.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(pageReply()); await f.settle(newCheck);
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});

test('a retired follow waiting in poll cannot dispatch reads into a replacement record', async () => {
  const f = await recoveryFixture();
  try {
    const polling = deferred<void>(), releasePoll = deferred<void>();
    resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
    const old = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('starting')); await f.settle(polling.promise);
    act(() => resume.resetContinueForPage());
    const newer = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const newPost = await f.post.take(); releasePoll.resolve(); await f.settle(old);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(newPost) });
    expect(f.requests.filter(request => request.url.pathname.endsWith(operation('ready').operationId))).toHaveLength(0);
    newPost.reply(stateReply('ready'));
    (await f.page.take()).reply(pageReply()); await f.settle(newer);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});

test('a writable completion from a replaced loader cannot clear recovery for the current loader', async () => {
  const f = await recoveryFixture();
  const replacement = new SessionMessageLoader(f.children, { sdk: opencodeClient.getSdkClient(), runtimeKey: getRuntimeKey() });
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    const oldPage = await f.page.take();
    setImperativeSessionMessageLoader(replacement);
    const currentPage = replacement.ensure(target, { reason: 'navigation' });
    (await f.page.take()).reply(pageReply(true)); await currentPage;
    oldPage.reply(pageReply()); await f.settle(continuing);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(replacement.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(f.status()).toMatchObject({ status: 'unknown', operationId: operation('ready').operationId });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { replacement.dispose(); await f.close(); }
});

test('a retired operation read cannot refresh or overwrite a replacement owner', async () => {
  const f = await recoveryFixture();
  try {
    resume.resumeTiming.poll = async () => {};
    const old = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('starting'));
    const oldRead = await f.read.take(); act(() => resume.resetContinueForPage());
    const newer = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const newPost = await f.post.take(); oldRead.reply(stateReply('ready')); await f.settle(old);
    expect(f.status()).toMatchObject({ status: 'starting', requestId: f.requestId(newPost) });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
    newPost.reply(stateReply('ready'));
    (await f.page.take()).reply(pageReply()); await f.settle(newer);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});
