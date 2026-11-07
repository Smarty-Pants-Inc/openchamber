import { afterEach, expect, test } from 'bun:test';
import { browserPiVoiceMedia } from './piVoiceMedia';

// Phone round (smarty-code#1192): iOS Safari refuses audio.play() outside a tap, and the agent's
// voice arrives after the Call tap's awaits. The page must say so and let one tap turn it on.
const NAMES = ['Audio', 'AudioContext', 'RTCPeerConnection', 'document', 'navigator'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
afterEach(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

type FakeStream = { getAudioTracks(): never[] };
type FakeTrackEvent = { streams: FakeStream[] };
interface FakePage { allowPlay: boolean; plays: number; resumes: number; audio?: { paused: boolean };
  peer?: { ontrack: ((event: FakeTrackEvent) => void) | null } }
function browser() {
  const page: FakePage = { allowPlay: false, plays: 0, resumes: 0 };
  class FakeAudio {
    autoplay = false; srcObject: FakeStream | null = null; paused = true;
    constructor() { page.audio = this; }
    play() {
      page.plays++;
      if (!page.allowPlay) return Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
      this.paused = false;
      return Promise.resolve();
    }
  }
  class FakeAudioContext {
    state = 'running';
    resume() { page.resumes++; return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class FakePeer {
    iceGatheringState = 'complete'; connectionState = 'new'; localDescription: { sdp: string } | null = null;
    ontrack: ((event: FakeTrackEvent) => void) | null = null; onconnectionstatechange = null;
    constructor() { page.peer = this; }
    addTrack() {} close() {} addEventListener() {}
    createDataChannel() { return { onopen: null }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 page' }; }
    async setLocalDescription(description: { sdp: string }) { this.localDescription = description; }
  }
  const track = { enabled: true, stop() {}, addEventListener() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const values = { Audio: FakeAudio, AudioContext: FakeAudioContext, RTCPeerConnection: FakePeer, document: doc,
    navigator: { mediaDevices: { getUserMedia: async () => stream } } };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  return { page, doc };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a voice the phone refused to play is reported; a tap plays it and clears the report', async () => {
  const { page } = browser();
  const media = browserPiVoiceMedia(), blocked: boolean[] = [];
  media.onAudioBlocked(value => blocked.push(value));
  await media.prepare();
  await media.offer({ open() {}, failed() {} });
  page.peer?.ontrack?.({ streams: [{ getAudioTracks: () => [] }] }); // The agent's voice arrives, outside any tap.
  await settle();
  expect(blocked).toEqual([true]);
  page.allowPlay = true; // The person's tap.
  const resumes = page.resumes;
  media.unlockAudio();
  expect(page.resumes).toBe(resumes + 1); // Called inside the tap, before any await.
  await settle();
  expect(blocked).toEqual([true, false]);
  media.close();
});

test('a voice that plays reports nothing; one the phone paused in the background is retried, and reported, when the page returns', async () => {
  const { page, doc } = browser();
  page.allowPlay = true;
  const media = browserPiVoiceMedia(), blocked: boolean[] = [];
  media.onAudioBlocked(value => blocked.push(value));
  await media.prepare();
  await media.offer({ open() {}, failed() {} });
  page.peer?.ontrack?.({ streams: [{ getAudioTracks: () => [] }] });
  await settle();
  expect(blocked).toEqual([]);
  const plays = page.plays;
  doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(page.plays).toBe(plays); // Still playing: nothing to retry.
  // iOS paused the element in the background and refuses to restart it without a tap.
  if (page.audio) page.audio.paused = true;
  page.allowPlay = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(page.plays).toBe(plays + 1);
  expect(blocked).toEqual([true]);
  media.close();
});
