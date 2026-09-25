import type { PiVoiceMedia, PiVoiceSocket, PiVoiceState } from './piVoiceCall';
import type { PiVoiceCallDriver } from './piVoiceActiveCall';

/** One fake call made by the test driver: its session, its state callback and what ended it. */
export type FakePiVoiceCall = { session?: string; state?: (next: PiVoiceState) => void; hungUp: boolean; micClosed: boolean };

/** A call driver for tests: fake media and socket, and a call that becomes active at once. */
export function fakePiVoiceDriver(options: { deny?: boolean } = {}) {
  const calls: FakePiVoiceCall[] = [];
  const socket: PiVoiceSocket = { readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null, send() {}, close() {} };
  const driver: PiVoiceCallDriver = {
    media(): PiVoiceMedia {
      const fake: FakePiVoiceCall = { hungUp: false, micClosed: false };
      calls.push(fake);
      return {
        prepare: () => options.deny ? Promise.reject(new Error('Permission denied')) : Promise.resolve(),
        onLost() {}, offer: async () => 'v=0', answer: async () => {}, setMuted() {}, levels: () => undefined, hangup() {},
        close() { fake.micClosed = true; },
      };
    },
    load: async () => ({
      openPiVoiceSocket(sessionId: string) { const call = calls.at(-1); if (call) call.session = sessionId; return socket; },
      async beginPiVoiceCall(prepared: Promise<void>, media: PiVoiceMedia, openSocket: () => PiVoiceSocket,
        onState: (state: PiVoiceState) => void, wanted: () => boolean) {
        await prepared;
        if (!wanted()) { media.close(); return undefined; }
        openSocket();
        const call = calls.at(-1)!;
        call.state = onState;
        onState({ status: 'active', phase: 'connecting', muted: false, transcript: null });
        return { hangup() { call.hungUp = true; media.close(); onState({ status: 'ended', error: null }); } };
      },
    }),
  };
  return { driver, calls };
}
