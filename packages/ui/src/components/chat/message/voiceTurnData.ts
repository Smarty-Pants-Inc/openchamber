import type { Part } from '@opencode-ai/sdk/v2';

/**
 * A voice call's spoken line, as the gateway projects smarty-voice's `smarty-voice-turn` entries (smarty-code#538,
 * gateway #568), told apart by `metadata.smartyVoice.speaker`:
 * - 'voice': a display-only assistant record in its turn. The list gives it the client role 'voice-turn'
 *   (messageDisplayNormalization), so it is its own row in journal order and never a reply of the turn. Since #739
 *   it renders as the written reply's collapsed "spoken" line, or as the reply itself when there is no written one.
 * - 'user' ("You said"): a user record, a turn like any other. The gateway parents the replies that follow on it, so
 *   it stays a user turn (its bubble reads "You said", HumanAuthor); it is never a voice-turn row.
 */
export type VoiceSpeaker = 'user' | 'voice';
export const VOICE_TURN_ROLE = 'voice-turn';

type VoiceMeta = { speaker?: unknown; request?: unknown; filler?: unknown; differs?: unknown; turn?: unknown };
const voiceMeta = (info: unknown): VoiceMeta | undefined =>
    (info as { metadata?: { smartyVoice?: VoiceMeta } } | undefined)?.metadata?.smartyVoice;

export const voiceSpeakerOf = (info: unknown): VoiceSpeaker | undefined => {
    const speaker = voiceMeta(info)?.speaker;
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
export const isVoiceRequest = (info: unknown): boolean => voiceMeta(info)?.request === true;

/** #739: filler ("Let me check that.", "Checking…"), marked by the gateway; never shown. */
export const isVoiceFiller = (info: unknown): boolean => voiceMeta(info)?.filler === true;

/** #739: the spoken words differ materially from the written reply (the gateway's test); shown open and amber. */
export const voiceDiffers = (info: unknown): boolean => voiceMeta(info)?.differs === true;

/** #739: the written reply a spoken line belongs to (`smartyVoice.turn`, the assistant message id), if marked. */
export const voiceReplyId = (info: unknown): string | undefined => {
    const turn = voiceMeta(info)?.turn;
    return typeof turn === 'string' && turn ? turn : undefined;
};

type Entry = { info: unknown; parts: Part[] };
const isWrittenReply = (entry: Entry | undefined): boolean =>
    (entry?.info as { role?: unknown } | undefined)?.role === 'assistant' && !isVoiceTurn(entry?.info) && voiceText(entry!.parts) !== '';

/**
 * Whether a spoken line is the voice's reading of a written reply (a collapsed "spoken" line under it) or a reply of
 * its own (no written text: its words are the reply). The gateway's `turn` mark decides; without it, the journal does:
 * a spoken line right after a written reply reads that reply.
 * ponytail: the adjacency fallback covers records projected before the gateway marks `turn`.
 */
export const spokenBelongsToReply = (message: Entry, previous: Entry | undefined): boolean => {
    const id = voiceReplyId(message.info);
    if (id) return true;
    return isWrittenReply(previous);
};
