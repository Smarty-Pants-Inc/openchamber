import { expect, test } from 'bun:test';
import { beginPiVoiceCall, startPiVoiceCall, type PiVoiceAudio, type PiVoiceDown, type PiVoiceSocket, type PiVoiceState } from './piVoiceCall';

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
interface AudioLog { mic: string; muted: boolean; played: number[][]; closed: number;
  capture?: (pcm: ArrayBuffer) => void; lost?: (reason: string) => void }
function fakeAudio() {
  const log: AudioLog = { mic: 'open', muted: false, played: [], closed: 0 };
  const audio: PiVoiceAudio = {
    async prepare() { log.mic = 'open'; },
    capture(onCapture, onLost) { log.capture = onCapture; log.lost = onLost; },
    play(pcm) { log.played.push([...new Uint8Array(pcm)]); },
    setMuted(muted) { log.muted = muted; },
    close() { log.closed++; log.mic = 'closed'; },
  };
  return { audio, log };
}

test('starts on open, opens the microphone only when live, and moves PCM both ways', async () => {
  const s = fakeSocket(), { audio, log } = fakeAudio(), states: PiVoiceState[] = [];
  startPiVoiceCall(s.socket, audio, state => states.push(state));
  expect(s.socket.binaryType).toBe('arraybuffer');
  s.open();
  expect(s.log.json).toEqual([{ type: 'start' }]);
  s.down({ type: 'state', phase: 'connecting' });
  log.capture?.(new Uint8Array([5]).buffer); // Prepared microphone, call not live yet: nothing is sent.
  expect(s.log.audio).toEqual([]);
  s.down({ type: 'state', active: true, muted: false });
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

test('a server end, a lost socket or a lost microphone end the call with a reason', () => {
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
  const s = fakeSocket(), { audio, log } = fakeAudio(), states: PiVoiceState[] = [];
  startPiVoiceCall(s.socket, audio, state => states.push(state));
  s.open();
  log.lost?.('The microphone was disconnected');
  expect(states.at(-1)).toEqual({ status: 'ended', error: 'The microphone was disconnected' });
  expect(log.closed).toBe(1);
});

test('a denied microphone or a vanished control opens no socket; a prepared one starts the call', async () => {
  let opened = 0;
  const open = () => { opened++; return fakeSocket().socket; };
  const denied = fakeAudio();
  await expect(beginPiVoiceCall(Promise.reject(new Error('Permission denied')), denied.audio, open, () => {}, () => true))
    .rejects.toThrow('Permission denied');
  expect(denied.log.closed).toBe(1);
  const gone = fakeAudio();
  expect(await beginPiVoiceCall(Promise.resolve(), gone.audio, open, () => {}, () => false)).toBeUndefined();
  expect(gone.log.closed).toBe(1);
  expect(opened).toBe(0);
  const states: PiVoiceState[] = [];
  const call = await beginPiVoiceCall(Promise.resolve(), fakeAudio().audio, open, state => states.push(state), () => true);
  expect(opened).toBe(1);
  expect(states.at(-1)).toMatchObject({ status: 'active', phase: 'connecting' });
  call?.hangup();
});
