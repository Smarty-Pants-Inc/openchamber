import React, { act } from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { nativeComposerDom } from '@/components/chat/composer/submit/__tests__/nativeComposer-dom';

// smarty-code#365: follow a start by reads, keep lost replies unknown, and respect the current runtime/view authority.
type Target = { directory: string; sessionID: string };
const ensured: [Target, { reason?: string; force?: boolean }][] = [];
let historyReady = true;
mock.module('@/sync/session-message-loader', () => ({ getImperativeSessionMessageLoader: () => ({
  ensure: async (target: Target, options: { reason?: string; force?: boolean }) => { ensured.push([target, options]); },
  getSnapshot: () => ({ status: historyReady ? 'ready' : 'error', resolved: historyReady, readOnly: !historyReady }) }) }));
const { opencodeClient } = await import('@/lib/opencode/client');
const resume = await import('./native-session-resume');
const original = { post: opencodeClient.resumeNativeSession, read: opencodeClient.readNativeCreation, list: opencodeClient.listNativeCreations };
const directory = '/project', sessionID = 'ses_ended';
const start = (phase: NativeCreationState['phase'], clientRequestId?: string): NativeCreationState => {
  const value: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory,
    generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 2, phase, expiresAt: Date.now() + 300_000, canInitialReady: false };
  if (clientRequestId) value.clientRequestId = clientRequestId;
  return value;
};
let posts: string[] = [];
resume.resumeTiming.poll = async () => {};
const dom = nativeComposerDom();
const { createRoot } = await import('react-dom/client');
const resolver = getRuntimeUrlResolver();
afterAll(async () => { await dom.restore(); });
const Status = () => React.createElement('span', null, JSON.stringify(resume.useContinueStatus(sessionID, directory)));
const observe = async (work: () => Promise<void>) => {
  const root = createRoot(dom.container);
  try {
    await act(async () => root.render(React.createElement(Status)));
    await act(work);
    return dom.container.textContent ?? '';
  } finally { await act(async () => root.unmount()); }
};
afterEach(() => {
  opencodeClient.resumeNativeSession = original.post; opencodeClient.readNativeCreation = original.read;
  opencodeClient.listNativeCreations = original.list; ensured.length = 0; posts = []; resume.resetContinueForPage();
  historyReady = true; resume.resumeTiming.poll = async () => {}; setRuntimeUrlResolver(resolver);
});
const post = (answer: (requestId: string) => Promise<NativeCreationState>) => {
  opencodeClient.resumeNativeSession = async (_d, _s, requestId) => { posts.push(requestId); return answer(requestId); };
};

test('a start not ready yet is followed by reads until ready; then the view loads its history again, live', async () => {
  post(async () => start('starting'));
  const reads = [start('awaiting-trust'), start('starting'), start('ready')];
  opencodeClient.readNativeCreation = async () => reads.shift()!;
  await resume.continueEndedSession(directory, sessionID);
  expect(posts).toHaveLength(1);
  expect(reads).toEqual([]);
  expect(ensured).toEqual([[{ directory, sessionID }, { reason: 'navigation', force: true }]]);
});

test('a start that stopped says so, and is not followed further', async () => {
  post(async () => start('starting'));
  opencodeClient.readNativeCreation = async () => start('cancelled');
  await resume.continueEndedSession(directory, sessionID);
  expect(ensured).toEqual([]);
});

test('a lost reply is an unknown outcome: no second request; Check again finds its start by its request id and follows it', async () => {
  post(async () => { throw new TypeError('fetch failed'); });
  await resume.continueEndedSession(directory, sessionID);
  expect(posts).toHaveLength(1);
  let listed: NativeCreationState[] = [];
  opencodeClient.listNativeCreations = async () => listed;
  await resume.checkContinue(directory, sessionID);
  expect(posts).toHaveLength(1); expect(ensured).toEqual([]);
  listed = [start('ready', posts[0])];
  await resume.checkContinue(directory, sessionID);
  expect(posts).toHaveLength(1);
  expect(ensured).toHaveLength(1);
});

test('a refusal the server explained is passed on in its words and leaves no pending state', async () => {
  post(async () => { throw new NativeCreationError('unknown', undefined, "This session's Pi is still running; open it in its tab", undefined, 409); });
  const error = await resume.continueEndedSession(directory, sessionID).then(() => undefined, (cause: NativeCreationError) => cause);
  expect(error?.detail).toBe("This session's Pi is still running; open it in its tab");
  expect(posts).toHaveLength(1);
});

test('a failed Check again read is still unknown, never a checked no-start result', async () => {
  post(async () => { throw new TypeError('fetch failed'); });
  opencodeClient.listNativeCreations = async () => { throw new TypeError('read failed'); };
  const text = await observe(async () => {
    await resume.continueEndedSession(directory, sessionID);
    await resume.checkContinue(directory, sessionID);
  });
  expect(text).toContain('"status":"unknown"');
  expect(text).not.toContain('"checked":true');
  expect(posts).toHaveLength(1);
});

test('a safe error detail on HTTP 503 is an unknown outcome, not a definite refusal', async () => {
  post(async () => { throw new NativeCreationError('unknown', undefined, 'Outcome unknown; inspect the start', undefined, 503); });
  const text = await observe(() => resume.continueEndedSession(directory, sessionID));
  expect(text).toContain('"status":"unknown"');
  expect(posts).toHaveLength(1);
});

test('the ready start is not cleared while its history read failed or remains read-only', async () => {
  historyReady = false; post(async () => start('ready'));
  const text = await observe(() => resume.continueEndedSession(directory, sessionID));
  expect(text).toContain('"status":"unknown"');
  expect(text).toContain('"operationId"');
});

test('the follow loop cannot read or refresh the destination runtime after a switch', async () => {
  post(async () => start('starting'));
  let reads = 0;
  opencodeClient.readNativeCreation = async () => { reads++; return start('ready'); };
  resume.resumeTiming.poll = async () => { configureRuntimeUrlResolver({ apiBaseUrl: 'http://other.synthetic.invalid' }); };
  await resume.continueEndedSession(directory, sessionID);
  expect(reads).toBe(0); expect(ensured).toEqual([]);
});

test('two clicks before React commits still issue only one start', async () => {
  const finishes: Array<(value: NativeCreationState) => void> = [];
  post(() => new Promise<NativeCreationState>(resolve => { finishes.push(resolve); }));
  const first = resume.continueEndedSession(directory, sessionID);
  const second = resume.continueEndedSession(directory, sessionID);
  finishes.forEach(finish => finish(start('ready')));
  await Promise.all([first, second]);
  expect(posts).toHaveLength(1);
});
