import { expect, test } from 'bun:test';
import { beginPiVoiceCall, startPiVoiceCall, type PiVoiceDown, type PiVoiceMedia, type PiVoiceSocket, type PiVoiceState } from './piVoiceCall';

type Sent = PiVoiceDown | { type: string; sdp?: string; input?: number; output?: number; message?: string };
interface SocketLog { sent: Sent[]; closed?: number }
function fakeSocket() {
  const log: SocketLog = { sent: [] };
  let readyState = 0;
  const socket: PiVoiceSocket = {
    get readyState() { return readyState; },
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(data) { log.sent.push(JSON.parse(String(data))); },
    close(code) { log.closed = code; },
  };
  return { socket, log,
    open() { readyState = 1; socket.onopen?.(); },
    down(message: PiVoiceDown) { socket.onmessage?.({ data: JSON.stringify(message) }); },
    raw(data: string | ArrayBuffer) { socket.onmessage?.({ data }); },
    sent(type: string) { return log.sent.filter(m => m.type === type); } };
}
interface MediaLog { mic: string; peers: number; hangups: number; muted: boolean; remote: string; closed: number;
  events?: Parameters<PiVoiceMedia['offer']>[0]; lost?: (reason: string) => void }
function fakeMedia() {
  const log: MediaLog = { mic: 'open', peers: 0, hangups: 0, muted: false, remote: '', closed: 0 };
  const media: PiVoiceMedia = {
    async prepare() { log.mic = 'open'; },
    onLost(listener) { log.lost = listener; },
    async offer(events) { log.peers++; log.events = events; return 'v=0 page'; },
    async answer(sdp) { log.remote = sdp; },
    setMuted(muted) { log.muted = muted; },
    levels: () => log.peers ? { input: 0.25, output: 0.5 } : undefined,
    hangup() { log.hangups++; },
    close() { log.closed++; log.mic = 'closed'; },
  };
  return { media, log };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

test("speaks pbo /live's browser-page protocol: start, offer, answer, open, levels, status and transcript", async () => {
  const s = fakeSocket(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
  startPiVoiceCall(s.socket, media, state => states.push(state));
  s.open();
  expect(s.log.sent).toEqual([{ type: 'start' }]);
  s.down({ type: 'offer.request' });
  await until(() => s.sent('offer').length === 1);
  expect(s.sent('offer')[0]).toEqual({ type: 'offer', sdp: 'v=0 page' });
  s.down({ type: 'answer', sdp: 'v=0 answer' });
  await until(() => log.remote === 'v=0 answer');
  log.events?.open();
  expect(s.sent('open')).toHaveLength(1);
  await until(() => s.sent('levels').length > 0);
  expect(s.sent('levels')[0]).toEqual({ type: 'levels', input: 0.25, output: 0.5 });
  s.down({ type: 'status', status: 'listening' });
  s.down({ type: 'transcript', role: 'user', text: 'run the tests' });
  s.down({ type: 'mute', muted: true });
  expect(log.muted).toBe(true);
  expect(states.at(-1)).toEqual({ status: 'active', phase: 'listening', muted: true, transcript: { role: 'user', text: 'run the tests' } });
  s.down({ type: 'transcript', role: 'assistant', text: 'All tests passed.' });
  expect(states.at(-1)).toMatchObject({ transcript: { role: 'agent', text: 'All tests passed.' } });
  s.down({ type: 'status', status: 'x'.repeat(50) }); s.raw('not json'); s.raw(new ArrayBuffer(2)); // Ignored.
  expect(states.at(-1)).toMatchObject({ phase: 'listening' });
  log.events?.failed('WebRTC connection failed');
  expect(s.sent('failure')).toEqual([{ type: 'failure', message: 'WebRTC connection failed' }]);
  s.down({ type: 'hangup' }); // The engine replaced its peer: close it, keep the microphone for a re-offer.
  expect(log.hangups).toBe(1);
  expect(log.mic).toBe('open');
});

test('hangup releases the microphone before telling the server; every ending does the same', () => {
  const endings: [string, (s: ReturnType<typeof fakeSocket>, log: MediaLog) => void, string | null][] = [
    ['user', () => {}, null],
    ['engine', s => s.down({ type: 'ended', reason: 'Codex live sideband closed (1006)' }), 'Codex live sideband closed (1006)'],
    ['socket', s => s.socket.onclose?.({ code: 1006, reason: '' }), 'Voice connection closed'],
    ['microphone', (_s, log) => log.lost?.('The microphone was disconnected'), 'The microphone was disconnected'],
  ];
  for (const [name, end, reason] of endings) {
    const s = fakeSocket(), { media, log } = fakeMedia(), states: PiVoiceState[] = [];
    const call = startPiVoiceCall(s.socket, media, state => states.push(state));
    s.open();
    if (name === 'user') call.hangup(); else end(s, log);
    expect(log.closed).toBe(1);
    expect(states.at(-1)).toEqual({ status: 'ended', error: reason });
    expect(s.log.sent.at(-1)).toEqual({ type: 'stop' });
    call.hangup();
    expect(log.closed).toBe(1);
  }
});

test('a denied microphone or a vanished control opens no socket; a prepared one starts the call', async () => {
  let opened = 0;
  const open = () => { opened++; return fakeSocket().socket; };
  const denied = fakeMedia();
  await expect(beginPiVoiceCall(Promise.reject(new Error('Permission denied')), denied.media, open, () => {}, () => true))
    .rejects.toThrow('Permission denied');
  expect(denied.log.closed).toBe(1);
  const gone = fakeMedia();
  expect(await beginPiVoiceCall(Promise.resolve(), gone.media, open, () => {}, () => false)).toBeUndefined();
  expect(gone.log.closed).toBe(1);
  expect(opened).toBe(0);
  const states: PiVoiceState[] = [];
  const call = await beginPiVoiceCall(Promise.resolve(), fakeMedia().media, open, state => states.push(state), () => true);
  expect(opened).toBe(1);
  expect(states.at(-1)).toMatchObject({ status: 'active', phase: 'connecting' });
  call?.hangup();
});
