import type { Part } from '@opencode-ai/sdk/v2';

/**
 * A voice call's spoken line, as the gateway projects smarty-voice's `smarty-voice-turn` entries (smarty-code#538,
 * gateway #568), told apart by `metadata.smartyVoice.speaker`:
 * - 'voice' ("Voice said"): a display-only assistant record in its turn. The list gives it the client role
 *   'voice-turn' (messageDisplayNormalization), so it is its own row in journal order and never a reply of the turn.
 * - 'user' ("You said"): a user record, a turn like any other. The gateway parents the replies that follow on it, so
 *   it stays a user turn (its bubble reads "You said", HumanAuthor); it is never a voice-turn row.
 */
export type VoiceSpeaker = 'user' | 'voice';
export const VOICE_TURN_ROLE = 'voice-turn';

export const voiceSpeakerOf = (info: unknown): VoiceSpeaker | undefined => {
    const speaker = (info as { metadata?: { smartyVoice?: { speaker?: unknown } } } | undefined)?.metadata?.smartyVoice?.speaker;
    return speaker === 'user' || speaker === 'voice' ? speaker : undefined;
};

/** A display-only "Voice said" record (never a turn anchor, never a model for utility calls). */
export const isVoiceTurn = (info: unknown): boolean => voiceSpeakerOf(info) === 'voice';

/** The person's spoken words as a user turn: "You said" (a voice line, or a voice delegation's request). */
export const isYouSaid = (info: unknown): boolean => voiceSpeakerOf(info) === 'user' || isVoiceRequest(info);

export const voiceSpeaker = (info: unknown): VoiceSpeaker => voiceSpeakerOf(info) ?? 'voice';

export const voiceText = (parts: Part[]): string => parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean).join('\n').trim();

/** A voice delegation: the person's spoken request as the turn's user message (`metadata.smartyVoice.request`). */
export const isVoiceRequest = (info: unknown): boolean =>
    (info as { metadata?: { smartyVoice?: { request?: unknown } } } | undefined)?.metadata?.smartyVoice?.request === true;
