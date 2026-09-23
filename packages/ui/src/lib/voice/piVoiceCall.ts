import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

// Browser audio peer for a Pi session's /live controller (Smarty Code gateway voice routes).
// The browser owns only microphone, speaker and WebRTC media. Pi keeps signaling,
// provider credentials, sideband and delegation; the gateway relays the peer calls.

const downSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer.request') }),
  z.object({ type: z.literal('answer'), sdp: z.string().min(1) }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('hangup') }),
]);
const transcriptSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string() });
const pollSchema = z.object({
  version: z.number().int().nonnegative(),
  messages: z.array(downSchema),
  phase: z.string(),
  transcript: transcriptSchema.nullable().catch(null),
  ended: z.object({ error: z.string().nullable() }).nullable(),
});
const startSchema = z.object({ callId: z.string().regex(/^[\w-]{1,64}$/) });
const failureSchema = z.object({ data: z.object({ message: z.string().min(1) }) });

export type PiVoicePoll = z.infer<typeof pollSchema>;
export type PiVoiceUp = { type: 'offer'; sdp: string } | { type: 'open' } | { type: 'toggleMute' }
  | { type: 'levels'; input: number[]; output: number[] } | { type: 'failure'; message: string };
export type PiVoiceState =
  | { status: 'active'; phase: string; muted: boolean; transcript: z.infer<typeof transcriptSchema> | null }
  | { status: 'ended'; error: string | null };

export interface PiVoiceTransport {
  start(): Promise<string>;
  poll(callId: string, after: number, signal: AbortSignal): Promise<PiVoicePoll>;
  send(callId: string, messages: PiVoiceUp[]): Promise<void>;
  stop(callId: string): Promise<void>;
}

/** Gateway voice routes through the authenticated runtime transport. */
export function piVoiceTransport(sessionId: string, directory: string): PiVoiceTransport {
  const base = `/api/session/${encodeURIComponent(sessionId)}/voice`;
  const request = async (path: string, init: RequestInit & { after?: number } = {}) => {
    const { after, ...rest } = init;
    const response = await runtimeFetch(base + path, { ...rest,
      query: after === undefined ? { directory } : { directory, after: String(after) } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failureSchema.safeParse(body).data?.data.message ?? `HTTP ${response.status}`);
    return body;
  };
  const json = (messages: PiVoiceUp[]) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }) });
  return {
    start: async () => startSchema.parse(await request('', { method: 'POST' })).callId,
    poll: async (callId, after, signal) => pollSchema.parse(await request(`/${callId}`, { after, signal })),
    send: async (callId, messages) => { await request(`/${callId}`, json(messages)); },
    stop: async (callId) => { await request(`/${callId}`, { method: 'DELETE' }); },
  };
}

/** Browser media for one call: microphone, speaker and one WebRTC peer at a time. */
export interface PiVoiceMedia {
  /** Opens the microphone and a new peer, then returns its complete SDP offer. */
  offer(events: { open(): void; failed(message: string): void }): Promise<string>;
  answer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
  /** Microphone and speaker RMS while a peer has remote audio. */
  levels(): { input: number; output: number } | undefined;
  /** Stops tracks and closes the peer; `offer` may run again. */
  release(): void;
  close(): void;
}

const LEVEL_MS = 100, FLUSH_MS = 400;

/** Starts one call. The server ends it on hangup, engine failure or session loss. */
export async function startPiVoiceCall(transport: PiVoiceTransport, media: PiVoiceMedia,
  onState: (state: PiVoiceState) => void) {
  const callId = await transport.start();
  const polling = new AbortController();
  let ended = false, muted = false, input: number[] = [], output: number[] = [];
  const outbox: PiVoiceUp[] = [];
  const send = (message: PiVoiceUp) => { outbox.push(message); };
  const finish = (error: string | null) => {
    if (ended) return; ended = true;
    polling.abort(); clearInterval(timer); media.release(); media.close();
    onState({ status: 'ended', error });
  };
  const timer = setInterval(() => {
    const level = media.levels();
    if (level) { input.push(muted ? 0 : level.input); output.push(level.output); }
    if (input.length * LEVEL_MS < FLUSH_MS && !outbox.length) return;
    const batch = [...outbox.splice(0, 30), ...(input.length ? [{ type: 'levels' as const, input, output }] : [])];
    input = []; output = [];
    if (batch.length) transport.send(callId, batch).catch(() => undefined);
  }, LEVEL_MS);
  const handle = async (message: z.infer<typeof downSchema>) => {
    if (message.type === 'offer.request') {
      media.release();
      const sdp = await media.offer({ open: () => send({ type: 'open' }),
        failed: reason => send({ type: 'failure', message: `Browser audio: ${reason}` }) });
      if (ended) media.release(); else send({ type: 'offer', sdp });
    } else if (message.type === 'answer') await media.answer(message.sdp);
    else if (message.type === 'mute') { muted = message.muted; media.setMuted(muted); }
    else media.release();
  };
  void (async () => {
    let after = 0;
    try {
      while (!ended) {
        const poll = await transport.poll(callId, after, polling.signal);
        after = poll.version;
        for (const message of poll.messages) {
          try { await handle(message); } catch (error) {
            send({ type: 'failure', message: `Browser audio: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) });
          }
        }
        if (poll.ended) { finish(poll.ended.error); return; }
        onState({ status: 'active', phase: poll.phase, muted, transcript: poll.transcript });
      }
    } catch (error) {
      if (ended) return;
      // Reads are not replayed mutations, but a lost control channel must not keep the mic open.
      await transport.stop(callId).catch(() => undefined);
      finish(error instanceof Error ? error.message : String(error));
    }
  })();
  onState({ status: 'active', phase: 'connecting', muted: false, transcript: null });
  return {
    callId,
    toggleMute: () => transport.send(callId, [{ type: 'toggleMute' }]),
    async hangup() {
      if (ended) return;
      await transport.stop(callId).catch(() => undefined);
      finish(null);
    },
  };
}
