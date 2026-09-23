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
  /** Opens the microphone; each captured PCM16 24 kHz frame goes to `onCapture`. */
  start(onCapture: (pcm: ArrayBuffer) => void): Promise<void>;
  play(pcm: ArrayBuffer): void;
  setMuted(muted: boolean): void;
  close(): void;
}

/** The authenticated runtime WebSocket for one session's voice call (cookie auth; no token in the URL). */
export function openPiVoiceSocket(sessionId: string, directory: string): PiVoiceSocket {
  return openRuntimeWebSocket(getRuntimeUrlResolver().websocket(`/api/session/${encodeURIComponent(sessionId)}/voice/socket`, { directory }));
}

const OPEN = 1;

/** Starts one call and owns `audio` from here on. Every ending path releases the microphone first. */
export function startPiVoiceCall(socket: PiVoiceSocket, audio: PiVoiceAudio, onState: (state: PiVoiceState) => void) {
  let ended = false, microphone = false;
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
    if (message.active) next.live = true;
    update(next);
    if (message.active && !microphone) {
      microphone = true;
      audio.start(pcm => send(pcm)).catch((error: Error) => finish(`Microphone unavailable: ${error.message}`));
    }
  };
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
