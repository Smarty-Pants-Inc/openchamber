import { isDesktopShell } from '@/lib/desktop';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { PiVoiceMedia } from './piVoiceCall';

const ICE_WAIT_MS = 2000;

/**
 * Runtime parity: web and hosted/Capacitor mobile pages that reach the server directly get the
 * control when they have WebRTC and a secure-context microphone. The private relay tunnel does not
 * carry the voice socket, and the desktop shell and VS Code (excluded by the control) are not
 * Code's web page, so they show none.
 */
export function supportsPiVoice(): boolean {
  return !isDesktopShell() && !getActiveRelayTunnel() && globalThis.window?.isSecureContext === true
    && 'RTCPeerConnection' in window && 'AudioContext' in window && Boolean(globalThis.navigator?.mediaDevices);
}

function meter(context: AudioContext, stream: MediaStream) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      return Math.sqrt(sum / buffer.length);
    },
    stop() { source.disconnect(); },
  };
}

function iceGathered(peer: RTCPeerConnection) {
  return new Promise<void>(resolve => {
    if (peer.iceGatheringState === 'complete') { resolve(); return; }
    peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, ICE_WAIT_MS);
  });
}

/**
 * Microphone, speaker and the call's RTCPeerConnection, as in pi-better-openai's /live browser page
 * (src/live/browser-page.ts): the page holds the media; the Pi session's /live engine signals it.
 * Create it inside the user's click so autoplay policy allows the remote voice and meters.
 */
export function browserPiVoiceMedia(): PiVoiceMedia {
  const audio = new Audio();
  audio.autoplay = true;
  const context = new AudioContext();
  let stream: MediaStream | undefined, peer: RTCPeerConnection | undefined, lost: (reason: string) => void = () => undefined;
  let meters: { mic: ReturnType<typeof meter>; speaker: ReturnType<typeof meter> } | undefined;
  // Backgrounding is not consent revocation: keep media, and resume audio the platform suspended.
  const resumeWhenVisible = () => { if (document.visibilityState === 'visible' && context.state !== 'running') void context.resume().catch(() => undefined); };
  const hangup = () => {
    meters?.mic.stop(); meters?.speaker.stop(); meters = undefined;
    peer?.close(); peer = undefined;
    audio.srcObject = null;
  };
  return {
    async prepare() {
      const resumed = context.resume(); // Inside the user's gesture.
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      await resumed;
      stream = microphone;
      for (const track of microphone.getAudioTracks()) track.addEventListener('ended', () => lost('The microphone was disconnected'));
      document.addEventListener('visibilitychange', resumeWhenVisible);
    },
    async offer(events) {
      const microphone = stream;
      if (!microphone) throw new Error('The microphone is not open');
      hangup();
      const connection = peer = new RTCPeerConnection();
      for (const track of microphone.getTracks()) connection.addTrack(track, microphone);
      // ponytail: data-channel events are not relayed: the engine uses its sideband, and a
      // page-forged server event must not reach the engine.
      connection.createDataChannel('oai-events').onopen = () => { if (peer === connection) events.open(); };
      connection.ontrack = event => {
        const remote = event.streams[0];
        if (!remote || peer !== connection) return;
        audio.srcObject = remote;
        void audio.play().catch(() => undefined);
        meters = { mic: meter(context, microphone), speaker: meter(context, remote) };
      };
      connection.onconnectionstatechange = () => {
        if (peer === connection && connection.connectionState === 'failed') events.failed('WebRTC connection failed');
      };
      await connection.setLocalDescription(await connection.createOffer());
      await iceGathered(connection);
      if (peer !== connection || !connection.localDescription) throw new Error('The call was replaced');
      return connection.localDescription.sdp;
    },
    async answer(sdp) { await peer?.setRemoteDescription({ type: 'answer', sdp }); },
    onLost(listener) { lost = listener; },
    setMuted(muted) { for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted; },
    levels: () => meters && { input: meters.mic.level(), output: meters.speaker.level() },
    hangup,
    close() {
      hangup();
      document.removeEventListener('visibilitychange', resumeWhenVisible);
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
      void context.close().catch(() => undefined);
    },
  };
}
