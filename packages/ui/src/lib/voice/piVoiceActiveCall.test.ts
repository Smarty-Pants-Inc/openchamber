import { afterEach, expect, test } from 'bun:test';
import { fakePiVoiceDriver } from './piVoiceTestDriver';
import { endActivePiVoiceCall, getActivePiVoiceCall, startPiVoiceCallFor } from './piVoiceActiveCall';

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
