/**
 * A voice call's spoken turn, as the gateway projects smarty-voice's `smarty-voice-turn` entries
 * (smarty-code#538): `clientRole: 'voice-turn'` and `metadata.smartyVoice.speaker`. Display only; never
 * the model's context. Herdr shows the same lines as "You said" / "Voice said".
 */
type Speaker = 'user' | 'voice';
type VoiceMeta = { speaker?: unknown };

const voiceMeta = (info: unknown): VoiceMeta | undefined => {
    const meta = (info as { metadata?: { smartyVoice?: unknown } } | undefined)?.metadata?.smartyVoice;
    return meta && typeof meta === 'object' ? meta as VoiceMeta : undefined;
};

export const isVoiceTurn = (info: unknown): boolean =>
    (info as { clientRole?: unknown } | undefined)?.clientRole === 'voice-turn';

export const voiceSpeaker = (info: unknown): Speaker => {
    const speaker = voiceMeta(info)?.speaker;
    return speaker === 'user' ? 'user' : 'voice';
};
