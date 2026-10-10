import { expect, test } from 'bun:test';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { operation, pageReply, stateReply, failureReply } from './365-recovery-http.fixture';

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

for (const failed of [false, true]) test(`the ready start is not cleared while its history read failed or remains read-only, failure=${failed}`, async () => {
  const f = await recoveryFixture();
  try {
    const continuing = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
    (await f.post.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(failed ? new Response('Failed page', { status: 400 }) : pageReply(true));
    await f.settle(continuing);
    expect(f.status()).toMatchObject({ status: 'unknown', operationId: operation('ready').operationId });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
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
