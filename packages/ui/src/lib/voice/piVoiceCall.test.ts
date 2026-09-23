import { expect, test } from 'bun:test';
import { startPiVoiceCall, type PiVoiceMedia, type PiVoicePoll, type PiVoiceState, type PiVoiceTransport, type PiVoiceUp } from './piVoiceCall';

type Down = PiVoicePoll['messages'][number];
function fakeServer() {
  let version = 0, ended: PiVoicePoll['ended'] = null, phase = 'connecting';
  const queue: Down[] = [], sent: PiVoiceUp[] = [], waiters: (() => void)[] = [];
  let stops = 0;
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  const transport: PiVoiceTransport = {
    start: async () => 'call-1',
    async poll(_id, after, signal) {
      if (version <= after && !ended) await new Promise<void>((resolve, reject) => {
        waiters.push(resolve); signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return { version, messages: queue.splice(0), phase, transcript: null, ended };
    },
    send: async (_id, messages) => { sent.push(...messages); },
    stop: async () => { stops++; ended = { error: null }; wake(); },
  };
  return { transport, sent, get stops() { return stops; },
    push(message: Down, nextPhase = phase) { queue.push(message); phase = nextPhase; version++; wake(); },
    end(error: string | null) { ended = { error }; version++; wake(); } };
}
function fakeMedia() {
  interface MediaLog { mic: string; muted: boolean; remote: string; offers: number; releases: number; closed: number;
    events?: Parameters<PiVoiceMedia['offer']>[0] }
  const log: MediaLog = { mic: 'closed', muted: false, remote: '', offers: 0, releases: 0, closed: 0 };
  let denied = false;
  const media: PiVoiceMedia = {
    async offer(events) {
      if (denied) throw new Error('Permission denied');
      log.offers++; log.mic = 'open'; log.events = events;
      return 'v=0 browser';
    },
    async answer(sdp) { log.remote = sdp; },
    setMuted(muted) { log.muted = muted; },
    levels: () => log.mic === 'open' ? { input: 0.25, output: 0.5 } : undefined,
    release() { log.releases++; log.mic = 'closed'; },
    close() { log.closed++; },
  };
  return { media, log, deny() { denied = true; } };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

test('answers the engine offer request, reports open and ends by releasing every track', async () => {
  const server = fakeServer(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
  const call = await startPiVoiceCall(server.transport, media, state => states.push(state));
  server.push({ type: 'offer.request' });
  await until(() => server.sent.some(m => m.type === 'offer'));
  expect(server.sent.find(m => m.type === 'offer')).toEqual({ type: 'offer', sdp: 'v=0 browser' });
  server.push({ type: 'answer', sdp: 'v=0 answer' }, 'listening');
  await until(() => log.remote === 'v=0 answer');
  log.events?.open();
  await until(() => server.sent.some(m => m.type === 'open'));
  await until(() => server.sent.some(m => m.type === 'levels'));
  const levels = server.sent.find(m => m.type === 'levels');
  expect(levels?.type === 'levels' && levels.input.every(v => v === 0.25) && levels.output.every(v => v === 0.5)).toBe(true);
  server.push({ type: 'mute', muted: true });
  await until(() => log.muted);
  call.hangup();
  expect(server.stops).toBe(1);
  expect(log.mic).toBe('closed');
  expect(log.closed).toBe(1);
  expect(states.at(-1)).toEqual({ status: 'ended', error: null });
  expect(states.some(s => s.status === 'active' && s.phase === 'listening')).toBe(true);
});

test('an engine-side end releases the microphone and reports the reason', async () => {
  const server = fakeServer(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
  await startPiVoiceCall(server.transport, media, state => states.push(state));
  server.push({ type: 'offer.request' });
  await until(() => server.sent.some(m => m.type === 'offer'));
  server.push({ type: 'hangup' }); server.end('Codex live sideband closed (1006)');
  await until(() => states.at(-1)?.status === 'ended');
  expect(states.at(-1)).toEqual({ status: 'ended', error: 'Codex live sideband closed (1006)' });
  expect(log.mic).toBe('closed');
  expect(log.closed).toBe(1);
  expect(server.stops).toBe(0);
});

test('a denied microphone is reported to the engine instead of hanging the call', async () => {
  const server = fakeServer(), { media, deny } = fakeMedia();
  deny();
  await startPiVoiceCall(server.transport, media, () => {});
  server.push({ type: 'offer.request' });
  await until(() => server.sent.some(m => m.type === 'failure'));
  expect(server.sent.find(m => m.type === 'failure')).toEqual({ type: 'failure', message: 'Browser audio: Permission denied' });
});

test('a lost control channel stops the call instead of keeping the microphone open', async () => {
  const server = fakeServer(), { media } = fakeMedia(), states: PiVoiceState[] = [];
  server.transport.poll = async () => { throw new Error('HTTP 503'); };
  await startPiVoiceCall(server.transport, media, state => states.push(state));
  await until(() => states.at(-1)?.status === 'ended');
  expect(server.stops).toBe(1);
  expect(states.at(-1)).toEqual({ status: 'ended', error: 'HTTP 503' });
});

test('hangup releases the microphone before the server answers', async () => {
  const server = fakeServer(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
  server.transport.stop = () => new Promise(() => {}); // A stalled gateway.
  const call = await startPiVoiceCall(server.transport, media, state => states.push(state));
  server.push({ type: 'offer.request' });
  await until(() => log.mic === 'open');
  call.hangup();
  expect(log.mic).toBe('closed');
  expect(log.closed).toBe(1);
  expect(states.at(-1)).toEqual({ status: 'ended', error: null });
});

test('a lost control message ends the call; lost level reports do not', async () => {
  const server = fakeServer(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
  let failControl = false;
  const send = server.transport.send;
  server.transport.send = async (id, messages) => {
    if (messages.some(m => m.type !== 'levels') && failControl) throw new Error('HTTP 502');
    if (messages.every(m => m.type === 'levels')) throw new Error('dropped');
    await send(id, messages);
  };
  await startPiVoiceCall(server.transport, media, state => states.push(state));
  server.push({ type: 'offer.request' });
  await until(() => server.sent.some(m => m.type === 'offer'));
  await new Promise(resolve => setTimeout(resolve, 500)); // Level-only batches fail and are ignored.
  expect(states.at(-1)?.status).toBe('active');
  failControl = true;
  log.events?.open();
  await until(() => states.at(-1)?.status === 'ended');
  expect(states.at(-1)).toEqual({ status: 'ended', error: 'HTTP 502' });
  expect(server.stops).toBe(1);
  expect(log.mic).toBe('closed');
});

test('a refused start closes the media it was given', async () => {
  const server = fakeServer(), { media, log } = fakeMedia();
  server.transport.start = async () => { throw new Error('Live voice is unavailable in this session'); };
  await expect(startPiVoiceCall(server.transport, media, () => {})).rejects.toThrow('unavailable');
  expect(log.closed).toBe(1);
});
