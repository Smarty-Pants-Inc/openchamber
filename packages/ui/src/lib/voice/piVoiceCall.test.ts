import { expect, test } from 'bun:test';
import { startPiVoiceCall, type PiVoiceAudio, type PiVoiceDown, type PiVoiceSocket, type PiVoiceState } from './piVoiceCall';

interface SocketLog { json: unknown[]; audio: number[][]; closed?: number }
function fakeSocket() {
  const log: SocketLog = { json: [], audio: [] };
  let readyState = 0;
  const socket: PiVoiceSocket = {
    get readyState() { return readyState; },
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(data) {
      if (data instanceof ArrayBuffer) log.audio.push([...new Uint8Array(data)]);
      else log.json.push(JSON.parse(String(data)));
    },
    close(code) { log.closed = code; },
  };
  return { socket, log,
    open() { readyState = 1; socket.onopen?.(); },
    down(message: PiVoiceDown) { socket.onmessage?.({ data: JSON.stringify(message) }); },
    raw(data: string | ArrayBuffer) { socket.onmessage?.({ data }); } };
}
interface AudioLog { mic: string; muted: boolean; played: number[][]; closed: number; capture?: (pcm: ArrayBuffer) => void }
function fakeAudio(deny = false) {
  const log: AudioLog = { mic: 'closed', muted: false, played: [], closed: 0 };
  const audio: PiVoiceAudio = {
    async start(onCapture) { if (deny) throw new Error('Permission denied'); log.mic = 'open'; log.capture = onCapture; },
    play(pcm) { log.played.push([...new Uint8Array(pcm)]); },
    setMuted(muted) { log.muted = muted; },
    close() { log.closed++; log.mic = 'closed'; },
  };
  return { audio, log };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

test('starts on open, opens the microphone only when live, and moves PCM both ways', async () => {
  const s = fakeSocket(), { audio, log } = fakeAudio(), states: PiVoiceState[] = [];
  startPiVoiceCall(s.socket, audio, state => states.push(state));
  expect(s.socket.binaryType).toBe('arraybuffer');
  s.open();
  expect(s.log.json).toEqual([{ type: 'start' }]);
  s.down({ type: 'state', phase: 'connecting' });
  expect(log.mic).toBe('closed');
  s.down({ type: 'state', active: true, muted: false });
  await until(() => log.mic === 'open');
  log.capture?.(new Uint8Array([1, 2]).buffer);
  expect(s.log.audio).toEqual([[1, 2]]);
  s.raw(new Uint8Array([7, 8]).buffer);
  expect(log.played).toEqual([[7, 8]]);
  s.down({ type: 'state', phase: 'listening' });
  s.down({ type: 'state', muted: true });
  expect(log.muted).toBe(true);
  expect(states.at(-1)).toEqual({ status: 'active', phase: 'listening', muted: true, live: true, error: null });
  s.down({ type: 'error', message: 'Realtime hiccup' });
  expect(states.at(-1)).toMatchObject({ status: 'active', error: 'Realtime hiccup' });
  s.raw('not json'); s.raw(JSON.stringify({ type: 'state', phase: 'x'.repeat(100) })); // Ignored, not trusted.
  expect(states.at(-1)).toMatchObject({ phase: 'listening' });
});

test('hangup releases the microphone before telling the server', () => {
  const s = fakeSocket(), { audio, log } = fakeAudio(), states: PiVoiceState[] = [];
  const call = startPiVoiceCall(s.socket, audio, state => states.push(state));
  s.open();
  call.hangup();
  expect(log.closed).toBe(1);
  expect(s.log.json.at(-1)).toEqual({ type: 'stop' });
  expect(s.log.closed).toBe(1000);
  expect(states.at(-1)).toEqual({ status: 'ended', error: null });
  call.hangup();
  expect(log.closed).toBe(1);
});

test('a server end, a lost socket or a denied microphone end the call with a reason', async () => {
  const endings: [(s: ReturnType<typeof fakeSocket>) => void, string][] = [
    [s => s.down({ type: 'ended', reason: 'No voice provider is loaded in this session' }), 'No voice provider is loaded in this session'],
    [s => s.socket.onclose?.({ code: 1006, reason: '' }), 'Voice connection closed'],
    [s => s.socket.onerror?.(), 'Voice connection failed'],
  ];
  for (const [end, reason] of endings) {
    const s = fakeSocket(), { audio, log } = fakeAudio(), states: PiVoiceState[] = [];
    startPiVoiceCall(s.socket, audio, state => states.push(state));
    s.open();
    end(s);
    expect(states.at(-1)).toEqual({ status: 'ended', error: reason });
    expect(log.closed).toBe(1);
  }
  const s = fakeSocket(), { audio, log } = fakeAudio(true), states: PiVoiceState[] = [];
  startPiVoiceCall(s.socket, audio, state => states.push(state));
  s.open();
  s.down({ type: 'state', active: true });
  await until(() => states.at(-1)?.status === 'ended');
  expect(states.at(-1)).toEqual({ status: 'ended', error: 'Microphone unavailable: Permission denied' });
  expect(log.closed).toBe(1);
});
