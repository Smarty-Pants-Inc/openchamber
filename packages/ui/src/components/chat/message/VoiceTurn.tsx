import type { Part } from '@opencode-ai/sdk/v2';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessageEntry } from '../lib/turns/types';

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

const textOf = (parts: Part[]) => parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean).join('\n').trim();

export function VoiceTurn({ message }: { message: ChatMessageEntry }) {
    const { t } = useI18n();
    const speaker = voiceSpeaker(message.info);
    const text = textOf(message.parts);
    if (!text) return null;
    // A relayed org reply is spoken by voice, so it is a "Voice said" line too.
    const label = speaker === 'user' ? t('chat.voiceTurn.you') : t('chat.voiceTurn.voice');
    const mine = speaker === 'user';
    return (
        <div className="group w-full pt-3 pb-1" id={`message-${message.info.id}`} data-message-id={message.info.id}
            data-voice-turn={speaker}>
            <div className={cn('chat-message-column flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] min-w-0', mine && 'text-right')}>
                    <div className={cn('mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground',
                        mine && 'justify-end')}>
                        <Icon name={mine ? 'mic' : 'volume-up'} className="size-3.5" aria-hidden />
                        <span>{label}</span>
                    </div>
                    <p className={cn('whitespace-pre-wrap break-words text-left typography-markdown text-foreground',
                        mine ? 'rounded-xl rounded-br-sm border border-primary/5 px-4 py-2.5' : 'border-l-2 border-border pl-3')}
                        style={mine ? { backgroundColor: 'var(--chat-user-message-bg)' } : undefined}>
                        {text}
                    </p>
                </div>
            </div>
        </div>
    );
}
