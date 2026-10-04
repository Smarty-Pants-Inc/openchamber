import { expect, test } from 'bun:test';
import { NATIVE_CREATION_DEADLINE_MS } from '@/lib/opencode/nativeCreationDeadline';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { deferred, operation, pageReply, stateReply, failureReply } from './365-recovery-http.fixture';
import { applyDirectoryEvent } from './event-reducer';

// Existing controls now use the real loader and private HTTP instead of module mocks.
// Operation phases below test read-following only, not native launch or session-only trust consent.
test('a start not ready yet is followed by reads until ready; then the view loads its history again, live', async () => {
  const f = await recoveryFixture();
  try {
    resume.resumeTiming.poll = async () => {};
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const post = await f.post.take(); post.reply(stateReply('starting', f.requestId(post)));
    for (const phase of ['awaiting-trust', 'starting', 'ready'] as const) (await f.read.take()).reply(stateReply(phase));
    (await f.page.take()).reply(pageReply()); await f.settle(continuing);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith(operation('ready').operationId))).toHaveLength(3);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', readOnly: false, resolved: true });
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});

for (const failed of [false, true]) test(`a ready start waits for a later live history read, first read failed=${failed}`, async () => {
  const f = await recoveryFixture();
  const polling = deferred<void>(), releasePoll = deferred<void>();
  try {
    resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(failed ? new Response('Failed page', { status: 400 }) : pageReply(true));
    await f.settle(Promise.race([polling.promise, continuing]));
    expect(f.status()).toMatchObject({ status: 'starting' });
    releasePoll.resolve();
    (await f.page.take()).reply(pageReply()); await f.settle(continuing);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(2);
  } finally { releasePoll.resolve(); await f.close(); }
});

test('a live event during the first live page keeps Continue pending until the loader accepts a later page', async () => {
  const f = await recoveryFixture();
  const polling = deferred<void>(), releasePoll = deferred<void>();
  try {
    const opening = f.start(() => f.loader.ensure(target));
    (await f.page.take()).reply(pageReply(true)); await f.settle(opening);
    resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    const stalePage = await f.page.take();
    const store = f.children.ensureChild(target.directory, { bootstrap: false });
    const draft = { ...store.getState() };
    applyDirectoryEvent(draft, { id: 'evt_1171', type: 'message.updated', properties: { sessionID: target.sessionID, info: {
      id: 'msg_1171', sessionID: target.sessionID, role: 'user', time: { created: 2 }, agent: 'build',
      model: { providerID: 'preserved-provider', modelID: 'preserved-model' },
    } } });
    store.setState(draft);
    stalePage.reply(pageReply());
    await f.settle(Promise.race([polling.promise, continuing]));
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(f.status()).toMatchObject({ status: 'starting' });
    const refresh = f.start(() => f.loader.refreshTail(target, 50));
    (await f.page.take()).reply(pageReply()); await f.settle(refresh);
    releasePoll.resolve(); await f.settle(continuing);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(3);
  } finally { releasePoll.resolve(); await f.close(); }
});

test('a start that stopped says so, and is not followed further', async () => {
  const f = await recoveryFixture();
  try {
    resume.resumeTiming.poll = async () => {};
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('starting'));
    (await f.read.take()).reply(stateReply('cancelled')); await f.settle(continuing);
    expect(f.status()).toEqual({ status: 'stopped' });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
  } finally { await f.close(); }
});

test('a lost reply is an unknown outcome: no second request; Check again finds its start by its request id and follows it', async () => {
  const f = await recoveryFixture();
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const post = await f.post.take(); post.lose(); await f.settle(continuing);
    await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
    const checking = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).reply(Response.json({ nativeCreations: [] })); await f.settle(checking);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
    const found = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready', f.requestId(post))] }));
    (await f.page.take()).reply(pageReply()); await f.settle(found);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});

test('a refusal the server explained is passed on in its words and leaves no pending state', async () => {
  const f = await recoveryFixture();
  try {
    let refusal: NativeCreationError | undefined;
    const continuing = f.start(async () => {
      try { await resume.continueEndedSession(target.directory, target.sessionID); }
      catch (error) { if (!(error instanceof NativeCreationError)) throw error; refusal = error; }
    });
    (await f.post.take()).reply(failureReply(409)); await f.settle(continuing);
    expect(refusal).toBeInstanceOf(NativeCreationError);
    expect(refusal?.detail).toBe('Recovery request refused'); expect(refusal?.status).toBe(409);
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});

test('a failed Check again read is still unknown, never a checked no-start result', async () => {
  const f = await recoveryFixture();
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).lose(); await f.settle(continuing);
    const checking = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).lose(); await f.settle(checking);
    const current = f.status();
    expect(current).toMatchObject({ status: 'unknown' });
    expect(current?.status === 'unknown' ? current.checked : undefined).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});

test('a safe error detail on HTTP 503 is an unknown outcome, not a definite refusal', async () => {
  const f = await recoveryFixture();
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(failureReply(503)); await f.settle(continuing);
    expect(f.status()).toMatchObject({ status: 'unknown' });
    await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});

for (const failed of [false, true]) test(`a ready start becomes unknown only at its history deadline, read failed=${failed}`, async () => {
  const clock = { value: Date.now() };
  const f = await recoveryFixture();
  const previousNow = resume.resumeTiming.now;
  const polling = deferred<void>(), releasePoll = deferred<void>();
  resume.resumeTiming.now = () => clock.value;
  try {
    resume.resumeTiming.poll = async () => { polling.resolve(); await releasePoll.promise; };
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(failed ? new Response('Failed page', { status: 400 }) : pageReply(true));
    await f.settle(Promise.race([polling.promise, continuing]));
    expect(f.status()).toMatchObject({ status: 'starting' });
    clock.value += NATIVE_CREATION_DEADLINE_MS + 1; releasePoll.resolve();
    await f.settle(continuing);
    expect(f.status()).toMatchObject({ status: 'unknown', operationId: operation('ready').operationId });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(1);
    const checking = f.start(() => resume.checkContinue(target.directory, target.sessionID));
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready')] }));
    (await f.page.take()).reply(pageReply()); await f.settle(checking);
    expect(f.status()).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { releasePoll.resolve(); resume.resumeTiming.now = previousNow; await f.close(); }
});

test('the follow loop cannot read or refresh the destination runtime after a switch', async () => {
  const f = await recoveryFixture();
  try {
    resume.resumeTiming.poll = async () => { configureRuntimeUrlResolver({ apiBaseUrl: `${f.base}/new-runtime` }); };
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('starting')); await f.settle(continuing);
    expect(f.status()).toMatchObject({ status: 'unknown' });
    expect(f.requests.filter(request => request.url.pathname.endsWith(operation('ready').operationId))).toHaveLength(0);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(0);
  } finally { await f.close(); }
});

test('two clicks before React commits still issue only one start', async () => {
  const f = await recoveryFixture();
  try {
    const first = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    const second = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(pageReply()); await f.settle(Promise.all([first, second]).then(() => {}));
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.status()).toBeUndefined();
  } finally { await f.close(); }
});
