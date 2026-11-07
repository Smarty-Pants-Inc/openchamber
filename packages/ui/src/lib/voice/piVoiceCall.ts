import { z } from 'zod';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

// Browser side of a Smarty Code session voice call. The page holds the WebRTC call; the selected
// Pi session's /live engine (pi-better-openai) signals it and delegates into that session. The
// socket carries the engine's own browser-page protocol through Code's gateway.

const downSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer.request') }),
  z.object({ type: z.literal('answer'), sdp: z.string().startsWith('v=0').max(64 * 1024) }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('hangup') }),
  z.object({ type: z.literal('status'), status: z.string().max(32) }),
  z.object({ type: z.literal('transcript'), role: z.string().max(16), text: z.string().max(2000) }),
  z.object({ type: z.literal('ended'), reason: z.string().max(300).nullable() }),
]);
export type PiVoiceDown = z.infer<typeof downSchema>;
export type PiVoiceUp = { type: 'start' } | { type: 'stop' } | { type: 'offer'; sdp: string } | { type: 'open' }
  | { type: 'levels'; input: number; output: number } | { type: 'failure'; message: string };
export type PiVoiceTranscript = { role: 'user' | 'agent'; text: string };
export type PiVoiceState =
  | { status: 'active'; phase: string; muted: boolean; transcript: PiVoiceTranscript | null; audioBlocked: boolean }
  | { status: 'ended'; error: string | null };

/** The call's socket: the runtime WebSocket shape (browser or relay tunnel), injectable for tests. */
export type PiVoiceSocket = RelayTunnelWebSocket;

/** Microphone, speaker and one RTCPeerConnection at a time for one call. */
export interface PiVoiceMedia {
  /** In the user's gesture: resume audio and open the microphone. A denied microphone throws, before any call. */
  prepare(): Promise<void>;
  /** Reports a microphone that went away (unplugged, revoked). */
  onLost(listener: (reason: string) => void): void;
  /** Reports whether the browser refused to play the agent's voice without a tap (iOS autoplay policy). */
  onAudioBlocked(listener: (blocked: boolean) => void): void;
  /** In the person's tap: resume audio and play the agent's voice. */
  unlockAudio(): void;
  /** Opens a new peer on the prepared microphone and returns its complete SDP offer. */
  offer(events: { open(): void; failed(message: string): void }): Promise<string>;
  answer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
  /** Microphone and speaker RMS while a peer has remote audio. */
  levels(): { input: number; output: number } | undefined;
  /** Closes the peer only; the microphone stays for a re-offer. */
  hangup(): void;
  /** Releases everything: peer, microphone tracks and audio. */
  close(): void;
}

/** The authenticated runtime WebSocket for one session's voice call (cookie auth; no token in the URL). */
export function openPiVoiceSocket(sessionId: string, directory: string): PiVoiceSocket {
  return openRuntimeWebSocket(getRuntimeUrlResolver().websocket(`/api/session/${encodeURIComponent(sessionId)}/voice/socket`, { directory }));
}

const OPEN = 1, LEVEL_MS = 100;
/** Waits before each reconnect of a call whose socket dropped; the call ends when they run out. */
const RETRY_DELAYS_MS = [1000, 3000, 6000];
// The engine's LivePhase values, and its transcript roles as the shared `you:`/`agent:` labels.
const PHASES = new Set(['standby', 'connecting', 'listening', 'working', 'speaking', 'muted', 'error']);

/**
 * Starts one call with a prepared microphone and owns `media` from here on. Every ending path releases the microphone first.
 * A socket that drops after it opened (a phone changing network, Safari parking the tab) is reopened on the same
 * microphone and the call starts again; one that never opened, or an engine `ended`, ends the call.
 */
export function startPiVoiceCall(openSocket: () => PiVoiceSocket, media: PiVoiceMedia, onState: (state: PiVoiceState) => void,
  options: { retryDelays?: number[] } = {}) {
  const retryDelays = options.retryDelays ?? RETRY_DELAYS_MS;
  const first = openSocket(); // A refused first open throws to the caller: the call never started.
  let ended = false, retries = 0, everOpened = false;
  let socket: PiVoiceSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let state: Extract<PiVoiceState, { status: 'active' }> = { status: 'active', phase: 'connecting', muted: false, transcript: null, audioBlocked: false };
  const send = (message: PiVoiceUp) => { if (socket?.readyState === OPEN) socket.send(JSON.stringify(message)); };
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; if (!ended) onState(state); };
  const finish = (error: string | null) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    clearTimeout(retry);
    media.close();
    send({ type: 'stop' });
    socket?.close(1000, 'Voice call ended');
    socket = undefined;
    onState({ status: 'ended', error });
  };
  const timer = setInterval(() => { const level = media.levels(); if (level) send({ type: 'levels', ...level }); }, LEVEL_MS);
  const offer = async () => {
    const sdp = await media.offer({ open: () => send({ type: 'open' }), failed: message => send({ type: 'failure', message }) });
    if (!ended) send({ type: 'offer', sdp });
  };
  const receive = (message: PiVoiceDown) => {
    if (message.type === 'ended') finish(message.reason);
    else if (message.type === 'offer.request') offer().catch((error: Error) => send({ type: 'failure', message: `Browser audio: ${error.message}`.slice(0, 400) }));
    else if (message.type === 'answer') media.answer(message.sdp).catch((error: Error) => send({ type: 'failure', message: `Browser audio: ${error.message}`.slice(0, 400) }));
    else if (message.type === 'mute') { media.setMuted(message.muted); update({ muted: message.muted }); }
    else if (message.type === 'hangup') media.hangup();
    else if (message.type === 'status') { if (PHASES.has(message.status)) update({ phase: message.status }); }
    else update({ transcript: { role: message.role === 'user' ? 'user' : 'agent', text: message.text } });
  };
  const connect = (opened?: PiVoiceSocket) => {
    let current: PiVoiceSocket;
    try { current = socket = opened ?? openSocket(); } catch (error) { finish(error instanceof Error ? error.message : String(error)); return; }
    // A browser fires error and then close for one drop; only the first one counts.
    const dropped = (reason: string) => {
      if (ended || socket !== current) return;
      socket = undefined;
      const delay = retryDelays[retries];
      if (!everOpened || delay === undefined) { finish(reason); return; }
      retries++;
      media.hangup(); // The engine's peer went with the socket; the microphone stays for the new start.
      update({ phase: 'reconnecting', transcript: null });
      retry = setTimeout(() => connect(), delay);
    };
    current.onopen = () => { if (socket === current) { everOpened = true; send({ type: 'start' }); } };
    current.onmessage = event => {
      if (ended || socket !== current || event.data instanceof ArrayBuffer) return; // No audio crosses this socket.
      let parsed: unknown;
      try { parsed = JSON.parse(event.data); } catch { parsed = undefined; }
      const message = downSchema.safeParse(parsed);
      if (!message.success) return;
      retries = 0; // The engine answered: the connection is back, with its whole retry budget.
      receive(message.data);
    };
    current.onerror = () => dropped('Voice connection failed');
    current.onclose = () => dropped('Voice connection closed');
  };
  media.onLost(reason => finish(reason));
  media.onAudioBlocked(audioBlocked => update({ audioBlocked }));
  connect(first);
  onState(state);
  return {
    hangup: () => finish(null),
    /** Call inside the person's tap: the browser plays the agent's voice only from a gesture. */
    unlockAudio: () => { if (!ended) media.unlockAudio(); },
  };
}

/**
 * Joins the gesture's microphone preparation to a new call. A denied or failed microphone, or a
 * control that went away meanwhile, opens no socket and starts no call; the media is closed instead.
 */
export async function beginPiVoiceCall(prepared: Promise<void>, media: PiVoiceMedia, openSocket: () => PiVoiceSocket,
  onState: (state: PiVoiceState) => void, wanted: () => boolean) {
  try { await prepared; } catch (error) { media.close(); throw error; }
  if (!wanted()) { media.close(); return undefined; }
  return startPiVoiceCall(openSocket, media, onState);
}
