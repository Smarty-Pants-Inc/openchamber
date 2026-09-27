import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessageEntry } from '../lib/turns/types';

import { voiceSpeaker, voiceText } from './voiceTurnData';

/** The "You said" mark on a voice delegation's request bubble (smarty-code#538). */
export function VoiceRequestLabel() {
    const { t } = useI18n();
    return (
        <span className="flex shrink-0 items-center gap-1" data-voice-request="true">
            <Icon name="mic" className="size-3.5" aria-hidden />
            <span>{t('chat.voiceTurn.you')}</span>
        </span>
    );
}

export function VoiceTurn({ message }: { message: ChatMessageEntry }) {
    const { t } = useI18n();
    const speaker = voiceSpeaker(message.info);
    const text = voiceText(message.parts);
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
