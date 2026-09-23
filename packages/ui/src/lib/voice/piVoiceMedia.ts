import { isDesktopShell } from '@/lib/desktop';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { PiVoiceAudio } from './piVoiceCall';
import { PI_VOICE_WORKLET, PI_VOICE_WORKLET_NAME } from './piVoiceWorklet';

/**
 * Runtime parity: web and hosted/Capacitor mobile pages that reach the server directly get the
 * control when they have AudioWorklet and a secure-context microphone. The private relay tunnel
 * does not carry the voice socket, and the desktop shell and VS Code (excluded by the control)
 * are not Code's web page, so they show none.
 */
export function supportsPiVoice(): boolean {
  return !isDesktopShell() && !getActiveRelayTunnel() && globalThis.window?.isSecureContext === true
    && 'AudioWorkletNode' in window && Boolean(globalThis.navigator?.mediaDevices);
}

/**
 * Real microphone and speaker for one call: PCM16 24 kHz frames through an AudioWorklet.
 * Create it inside the user's click so autoplay policy allows the remote voice.
 */
export function browserPiVoiceAudio(): PiVoiceAudio {
  const context = new AudioContext();
  void context.resume();
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
  let closed = false, epoch = 0;
  const release = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    source?.disconnect(); node?.disconnect();
    stream = undefined; source = undefined; node = undefined;
  };
  return {
    async start(onCapture) {
      const url = URL.createObjectURL(new Blob([PI_VOICE_WORKLET], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (closed) {
        for (const track of microphone.getTracks()) track.stop();
        throw new Error('Voice call ended');
      }
      stream = microphone;
      source = context.createMediaStreamSource(microphone);
      node = new AudioWorkletNode(context, PI_VOICE_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (event: MessageEvent<{ type?: string; epoch?: number; pcm?: ArrayBuffer }>) => {
        if (event.data.type === 'capture' && event.data.epoch === epoch && event.data.pcm) onCapture(event.data.pcm);
      };
      source.connect(node);
      node.connect(context.destination);
    },
    play(pcm) { node?.port.postMessage(pcm, [pcm]); },
    setMuted(muted) {
      epoch++;
      node?.port.postMessage({ type: 'input_muted', muted, epoch });
      for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
    },
    close() {
      closed = true;
      release();
      void context.close().catch(() => undefined);
    },
  };
}
