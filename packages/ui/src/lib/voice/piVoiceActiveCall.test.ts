import { afterEach, expect, test } from 'bun:test';
import { fakePiVoiceDriver } from './piVoiceTestDriver';
import { endActivePiVoiceCall, endPiVoiceCallForRuntimeChange, getActivePiVoiceCall, RUNTIME_CHANGED, startPiVoiceCallFor } from './piVoiceActiveCall';

const driver = (options: { deny?: boolean } = {}) => { const fake = fakePiVoiceDriver(options); return { d: fake.driver, calls: fake.calls }; };
const hooks = () => {
  const ended: string[] = [], failed: string[] = [], log = { ended, failed };
  return { log, hooks: { onEnded: (r: string) => log.ended.push(r), onFailed: (r: string) => log.failed.push(r) } }; };
afterEach(() => endActivePiVoiceCall());

test('a call stays bound to its session while the page shows other sessions', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'org', directory: '/p', state: { status: 'active' } });
  // Viewing another session is only a different render; nothing in the store changes.
  calls[0]!.state!({ status: 'active', phase: 'listening', muted: false, transcript: null });
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'org', state: { phase: 'listening' } });
  expect(calls[0]!.hungUp).toBe(false);
  expect(log).toEqual({ ended: [], failed: [] });
});

test('Move call here ends the old session call only after the new microphone is ready', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  await startPiVoiceCallFor('lane', '/p', d, h);
  expect(calls[0]).toMatchObject({ session: 'org', hungUp: true, micClosed: true });
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'lane', state: { status: 'active' } });
  expect(log.ended).toEqual([]); // A move is not an unexpected end.
  const denied = driver({ deny: true });
  await startPiVoiceCallFor('third', '/p', denied.d, h);
  expect(log.failed).toEqual(['Permission denied']);
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'lane' }); // The running call is kept.
  expect(calls[1]!.hungUp).toBe(false);
  expect(denied.calls[0]!.micClosed).toBe(true);
});

test('an engine-side end clears the call with its reason; ending while starting opens nothing', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  calls[0]!.state!({ status: 'ended', error: 'The Code page stopped responding' });
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(log.ended).toEqual(['The Code page stopped responding']);
  const starting = startPiVoiceCallFor('org', '/p', d, h);
  endActivePiVoiceCall();
  await starting;
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(calls[1]!.micClosed).toBe(true);
  expect(calls[1]!.session).toBeUndefined();
});

test('a runtime switch while the microphone prepares aborts the start: no call on the new runtime', async () => {
  let ready!: () => void;
  const { driver: d, calls, runtime } = fakePiVoiceDriver({ prepared: new Promise<void>(resolve => { ready = resolve; }) });
  const { hooks: h, log } = hooks();
  const starting = startPiVoiceCallFor('org', '/p', d, h); // Clicked on runtime A.
  runtime.key = 'B'; endPiVoiceCallForRuntimeChange(); // Switched to B while preparing.
  ready(); await starting;
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(calls[0]).toMatchObject({ micClosed: true });
  expect(calls[0]!.session).toBeUndefined(); // No socket opened, on either runtime.
  expect(log.failed).toEqual([RUNTIME_CHANGED]);
});

test('the same session ID on another runtime is another call; a runtime switch ends the live call with a notice', async () => {
  const { driver: d, calls, runtime } = fakePiVoiceDriver();
  const { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  expect(getActivePiVoiceCall()).toMatchObject({ runtimeKey: 'A', sessionId: 'org' });
  runtime.key = 'B'; endPiVoiceCallForRuntimeChange();
  expect(calls[0]).toMatchObject({ hungUp: true, micClosed: true });
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(log.ended).toEqual([RUNTIME_CHANGED]);
  await startPiVoiceCallFor('org', '/p', d, h); // Same session ID and directory, now on B.
  expect(getActivePiVoiceCall()).toMatchObject({ runtimeKey: 'B', sessionId: 'org' });
  expect(calls[1]).toMatchObject({ session: 'org', hungUp: false });
});

test('even without a change event, a start whose runtime is no longer current never opens a socket', async () => {
  let ready!: () => void;
  const { driver: d, calls, runtime } = fakePiVoiceDriver({ prepared: new Promise<void>(resolve => { ready = resolve; }) });
  const { hooks: h, log } = hooks();
  const starting = startPiVoiceCallFor('org', '/p', d, h);
  runtime.key = 'B'; // The endpoint moved; no event reached the store.
  ready(); await starting;
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(calls[0]!.session).toBeUndefined();
  expect(log.failed).toEqual([RUNTIME_CHANGED]);
});
