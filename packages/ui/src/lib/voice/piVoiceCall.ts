import { z } from 'zod';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

// Browser side of a Smarty Code session voice call. Code's gateway pipes one WebSocket to the
// selected Pi session's own voice server. The wire is engine-neutral: binary frames are PCM16LE
// 24 kHz mono both ways, and small JSON frames carry control and state.

const downSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), phase: z.string().max(32).optional(), muted: z.boolean().optional(), active: z.boolean().optional() }),
  z.object({ type: z.literal('error'), message: z.string().max(300) }),
  z.object({ type: z.literal('ended'), reason: z.string().max(300).nullable() }),
]);
export type PiVoiceDown = z.infer<typeof downSchema>;
export type PiVoiceUp = { type: 'start' } | { type: 'stop' };
export type PiVoiceState =
  | { status: 'active'; phase: string; muted: boolean; live: boolean; error: string | null }
  | { status: 'ended'; error: string | null };

/** The call's socket: the runtime WebSocket shape (browser or relay tunnel), injectable for tests. */
export type PiVoiceSocket = RelayTunnelWebSocket;

/** Microphone and speaker for one call. */
export interface PiVoiceAudio {
  /** In the user's gesture: resume audio and open the microphone. A denied microphone throws, before any call. */
  prepare(): Promise<void>;
  /** Routes captured PCM16 24 kHz frames; `onLost` reports a microphone that went away. */
  capture(onCapture: (pcm: ArrayBuffer) => void, onLost: (reason: string) => void): void;
  play(pcm: ArrayBuffer): void;
  setMuted(muted: boolean): void;
  close(): void;
}

/** The authenticated runtime WebSocket for one session's voice call (cookie auth; no token in the URL). */
export function openPiVoiceSocket(sessionId: string, directory: string): PiVoiceSocket {
  return openRuntimeWebSocket(getRuntimeUrlResolver().websocket(`/api/session/${encodeURIComponent(sessionId)}/voice/socket`, { directory }));
}

const OPEN = 1;

/**
 * Starts one call with a prepared microphone and owns `audio` from here on. Captured audio flows
 * only while the call is live. Every ending path releases the microphone first.
 */
export function startPiVoiceCall(socket: PiVoiceSocket, audio: PiVoiceAudio, onState: (state: PiVoiceState) => void) {
  let ended = false, live = false;
  let state: Extract<PiVoiceState, { status: 'active' }> = { status: 'active', phase: 'connecting', muted: false, live: false, error: null };
  const send = (message: PiVoiceUp | ArrayBuffer) => {
    if (socket.readyState === OPEN) socket.send(message instanceof ArrayBuffer ? message : JSON.stringify(message));
  };
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; if (!ended) onState(state); };
  const finish = (error: string | null) => {
    if (ended) return;
    ended = true;
    audio.close();
    send({ type: 'stop' });
    socket.close(1000, 'Voice call ended');
    onState({ status: 'ended', error });
  };
  const receive = (message: PiVoiceDown) => {
    if (message.type === 'ended') { finish(message.reason); return; }
    if (message.type === 'error') { update({ error: message.message }); return; }
    const next: Partial<typeof state> = {};
    if (message.phase) next.phase = message.phase;
    if (message.muted !== undefined) { next.muted = message.muted; audio.setMuted(message.muted); }
    if (message.active) { next.live = true; live = true; }
    update(next);
  };
  audio.capture(pcm => { if (live) send(pcm); }, reason => finish(reason));
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => send({ type: 'start' });
  socket.onmessage = event => {
    if (ended) return;
    if (event.data instanceof ArrayBuffer) { audio.play(event.data); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(event.data); } catch { parsed = undefined; }
    const message = downSchema.safeParse(parsed);
    if (message.success) receive(message.data);
  };
  socket.onerror = () => finish('Voice connection failed');
  socket.onclose = () => finish('Voice connection closed');
  onState(state);
  return { hangup: () => finish(null) };
}

/**
 * Joins the gesture's microphone preparation to a new call. A denied or failed microphone, or a
 * control that went away meanwhile, opens no socket and starts no call; the audio is closed instead.
 */
export async function beginPiVoiceCall(prepared: Promise<void>, audio: PiVoiceAudio, openSocket: () => PiVoiceSocket,
  onState: (state: PiVoiceState) => void, wanted: () => boolean) {
  try { await prepared; } catch (error) { audio.close(); throw error; }
  if (!wanted()) { audio.close(); return undefined; }
  return startPiVoiceCall(openSocket(), audio, onState);
}
