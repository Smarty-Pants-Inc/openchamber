import type { Part } from '@opencode-ai/sdk/v2';

/**
 * A voice call's spoken line, as the gateway projects smarty-voice's `smarty-voice-turn` entries (smarty-code#538):
 * a plain assistant record in its turn with `metadata.smartyVoice.speaker` 'user' ("You said") or 'voice'
 * ("Voice said"). Display only; never the model's context. The list gives it the client role 'voice-turn'
 * (messageDisplayNormalization), so it is its own row in journal order and never a reply of the turn.
 */
export type VoiceSpeaker = 'user' | 'voice';
export const VOICE_TURN_ROLE = 'voice-turn';

export const voiceSpeakerOf = (info: unknown): VoiceSpeaker | undefined => {
    const speaker = (info as { metadata?: { smartyVoice?: { speaker?: unknown } } } | undefined)?.metadata?.smartyVoice?.speaker;
    return speaker === 'user' || speaker === 'voice' ? speaker : undefined;
};

export const isVoiceTurn = (info: unknown): boolean => voiceSpeakerOf(info) !== undefined;

export const voiceSpeaker = (info: unknown): VoiceSpeaker => voiceSpeakerOf(info) ?? 'voice';

export const voiceText = (parts: Part[]): string => parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean).join('\n').trim();

/** A "You said" line that repeats its turn's request (a voice delegation shows the same words): hidden. */
export const repeatsRequest = (line: { info: unknown; parts: Part[] }, request: { parts: Part[] } | undefined): boolean =>
    voiceSpeakerOf(line.info) === 'user' && request !== undefined && voiceText(line.parts) !== ''
    && voiceText(line.parts) === voiceText(request.parts);

/** A voice delegation: the person's spoken request as the turn's user message (`metadata.smartyVoice.request`). */
export const isVoiceRequest = (info: unknown): boolean =>
    (info as { metadata?: { smartyVoice?: { request?: unknown } } } | undefined)?.metadata?.smartyVoice?.request === true;
