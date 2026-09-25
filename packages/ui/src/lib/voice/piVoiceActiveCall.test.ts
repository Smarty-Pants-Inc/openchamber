import { afterEach, expect, test } from 'bun:test';
import type { PiVoiceMedia, PiVoiceSocket, PiVoiceState } from './piVoiceCall';
import { endActivePiVoiceCall, getActivePiVoiceCall, movePiVoiceCallHere, startPiVoiceCallFor, type PiVoiceCallDriver } from './piVoiceActiveCall';

type Fake = { session: string; state(next: PiVoiceState): void; hungUp: boolean; micClosed: boolean };
function driver(options: { deny?: boolean } = {}) {
  const calls: Fake[] = [];
  const d: PiVoiceCallDriver = {
    media() {
      const fake = { micClosed: false } as Fake;
      calls.push(fake);
      return { prepare: () => options.deny ? Promise.reject(new Error('Permission denied')) : Promise.resolve(),
        close() { fake.micClosed = true; } } as unknown as PiVoiceMedia;
    },
    async load() {
      return {
        openPiVoiceSocket: (sessionId: string) => { calls.at(-1)!.session = sessionId; return {} as PiVoiceSocket; },
        async beginPiVoiceCall(prepared, media, openSocket, onState, wanted) {
          await prepared;
          if (!wanted()) { media.close(); return undefined; }
          openSocket();
          const fake = calls.at(-1)!;
          fake.state = onState;
          onState({ status: 'active', phase: 'connecting', muted: false, transcript: null });
          return { hangup() { fake.hungUp = true; media.close(); onState({ status: 'ended', error: null }); } };
        },
      };
    },
  };
  return { d, calls };
}
const hooks = () => { const log = { ended: [] as string[], failed: [] as string[] };
  return { log, hooks: { onEnded: (r: string) => log.ended.push(r), onFailed: (r: string) => log.failed.push(r) } }; };
afterEach(() => endActivePiVoiceCall());

test('a call stays bound to its session while the page shows other sessions', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'org', directory: '/p', state: { status: 'active' } });
  // Viewing another session is only a different render; nothing in the store changes.
  calls[0]!.state({ status: 'active', phase: 'listening', muted: false, transcript: null });
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'org', state: { phase: 'listening' } });
  expect(calls[0]!.hungUp).toBeUndefined();
  expect(log).toEqual({ ended: [], failed: [] });
});

test('Move call here ends the old session call only after the new microphone is ready', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  await movePiVoiceCallHere('lane', '/p', d, h);
  expect(calls[0]).toMatchObject({ session: 'org', hungUp: true, micClosed: true });
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'lane', state: { status: 'active' } });
  expect(log.ended).toEqual([]); // A move is not an unexpected end.
  const denied = driver({ deny: true });
  await movePiVoiceCallHere('third', '/p', denied.d, h);
  expect(log.failed).toEqual(['Permission denied']);
  expect(getActivePiVoiceCall()).toMatchObject({ sessionId: 'lane' }); // The running call is kept.
  expect(calls[1]!.hungUp).toBeUndefined();
  expect(denied.calls[0]!.micClosed).toBe(true);
});

test('an engine-side end clears the call with its reason; ending while starting opens nothing', async () => {
  const { d, calls } = driver(), { hooks: h, log } = hooks();
  await startPiVoiceCallFor('org', '/p', d, h);
  calls[0]!.state({ status: 'ended', error: 'The Code page stopped responding' });
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(log.ended).toEqual(['The Code page stopped responding']);
  const starting = startPiVoiceCallFor('org', '/p', d, h);
  endActivePiVoiceCall();
  await starting;
  expect(getActivePiVoiceCall()).toBeUndefined();
  expect(calls[1]!.micClosed).toBe(true);
  expect(calls[1]!.session).toBeUndefined();
});
