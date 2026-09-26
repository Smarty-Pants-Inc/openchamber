import { afterEach, expect, mock, test } from 'bun:test';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';

// smarty-code#365 review of openchamber#230: Continue follows a start that is not ready yet by reads until the view is
// live, and never reports "nothing started" (or repeats the request) after a reply that was lost.
type Target = { directory: string; sessionID: string };
const ensured: [Target, { reason?: string; force?: boolean }][] = [];
mock.module('@/sync/session-message-loader', () => ({ getImperativeSessionMessageLoader: () => ({
  ensure: async (target: Target, options: { reason?: string; force?: boolean }) => { ensured.push([target, options]); } }) }));
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
afterEach(() => {
  opencodeClient.resumeNativeSession = original.post; opencodeClient.readNativeCreation = original.read;
  opencodeClient.listNativeCreations = original.list; ensured.length = 0; posts = []; resume.resetContinueForPage();
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
  await resume.checkContinue(directory, sessionID); // Not listed: still unknown, never "nothing started".
  expect(posts).toHaveLength(1); expect(ensured).toEqual([]);
  listed = [start('ready', posts[0])];
  await resume.checkContinue(directory, sessionID);
  expect(posts).toHaveLength(1);
  expect(ensured).toHaveLength(1);
});

test('a refusal the server explained is passed on in its words and leaves no pending state', async () => {
  post(async () => { throw new NativeCreationError('unknown', undefined, "This session's Pi is still running; open it in its tab"); });
  const error = await resume.continueEndedSession(directory, sessionID).then(() => undefined, (cause: NativeCreationError) => cause);
  expect(error?.detail).toBe("This session's Pi is still running; open it in its tab");
  expect(posts).toHaveLength(1);
});
