import type { PiVoiceMedia } from './piVoiceCall';

const ICE_WAIT_MS = 2000;

/** Web runtimes with WebRTC and a secure-context microphone. Other runtimes show no voice control. */
export function supportsPiVoice(): boolean {
  return globalThis.window?.isSecureContext === true && 'RTCPeerConnection' in window && 'AudioContext' in window
    && Boolean(globalThis.navigator?.mediaDevices);
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
 * Real microphone, speaker and WebRTC for one call, as in pi-better-openai's browser page.
 * Create it inside the user's click so autoplay policy allows the remote voice and meters.
 */
export function browserPiVoiceMedia(): PiVoiceMedia {
  const audio = new Audio();
  audio.autoplay = true;
  const context = new AudioContext();
  void context.resume();
  let generation = 0, stream: MediaStream | undefined, peer: RTCPeerConnection | undefined;
  let meters: { mic: ReturnType<typeof meter>; speaker: ReturnType<typeof meter> } | undefined;
  const release = () => {
    generation++;
    meters?.mic.stop(); meters?.speaker.stop(); meters = undefined;
    peer?.close(); peer = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    audio.srcObject = null;
  };
  return {
    async offer(events) {
      const current = ++generation;
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (current !== generation) {
        for (const track of microphone.getTracks()) track.stop();
        throw new Error('Voice call was released');
      }
      stream = microphone;
      const connection = peer = new RTCPeerConnection();
      for (const track of microphone.getTracks()) connection.addTrack(track, microphone);
      // ponytail: data-channel events are not relayed. The engine ignores them while its
      // sideband is open and ends the call when the sideband fails.
      connection.createDataChannel('oai-events').onopen = () => events.open();
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
      if (peer !== connection || !connection.localDescription) throw new Error('Voice call was released');
      return connection.localDescription.sdp;
    },
    async answer(sdp) { await peer?.setRemoteDescription({ type: 'answer', sdp }); },
    setMuted(muted) { for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted; },
    levels: () => meters && { input: meters.mic.level(), output: meters.speaker.level() },
    release,
    close() { release(); void context.close().catch(() => undefined); },
  };
}
