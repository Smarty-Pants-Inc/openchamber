import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessageEntry } from '../lib/turns/types';

import { isVoiceFiller, spokenBelongsToReply, voiceDiffers, voiceSpeaker, voiceText } from './voiceTurnData';

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

/** #739: what the voice said while reading a written reply: one collapsed line under it; open and amber if it differs. */
function SpokenLine({ text, differs }: { text: string; differs: boolean }) {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(differs);
    return (
        <div className="typography-ui-meta">
            <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
                className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
                    differs ? 'bg-[var(--status-warning-background)] text-[var(--status-warning)]' : 'bg-muted/60 text-muted-foreground hover:text-foreground')}>
                <Icon name="volume-up" className="size-3.5" aria-hidden />
                <span>{t('chat.voiceTurn.spoken')}</span>
                {differs && <span className="font-semibold">{t('chat.voiceTurn.differs')}</span>}
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" aria-hidden />
            </button>
            {open && (
                <p className={cn('mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3 typography-markdown',
                    differs ? 'border-[var(--status-warning)] text-foreground' : 'border-border text-muted-foreground')}>
                    {text}
                </p>
            )}
        </div>
    );
}

export function VoiceTurn({ message, previousMessage }: { message: ChatMessageEntry; previousMessage?: ChatMessageEntry }) {
    const { t } = useI18n();
    const speaker = voiceSpeaker(message.info);
    const text = voiceText(message.parts);
    if (!text || isVoiceFiller(message.info)) return null;
    const row = (children: React.ReactNode, mine = false) => (
        <div className="group w-full pt-1 pb-1" id={`message-${message.info.id}`} data-message-id={message.info.id}
            data-voice-turn={speaker}>
            <div className={cn('chat-message-column flex', mine ? 'justify-end' : 'justify-start')}>{children}</div>
        </div>
    );
    if (speaker === 'voice') {
        // #739: one turn, one message. Reading a written reply: a collapsed line under it. No written reply: its words
        // are the reply, one plain line.
        if (spokenBelongsToReply(message, previousMessage)) return row(<SpokenLine text={text} differs={voiceDiffers(message.info)} />);
        return row(
            <p className="flex min-w-0 max-w-[85%] items-start gap-2 whitespace-pre-wrap break-words typography-markdown text-foreground"
                aria-label={t('chat.voiceTurn.voice')}>
                <Icon name="volume-up" className="mt-[0.3em] size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>{text}</span>
            </p>,
        );
    }
    return row(
        <div className="max-w-[85%] min-w-0 text-right">
            <div className="mb-1 flex items-center justify-end gap-1.5 typography-ui-meta text-muted-foreground">
                <Icon name="mic" className="size-3.5" aria-hidden />
                <span>{t('chat.voiceTurn.you')}</span>
            </div>
            <p className="whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-primary/5 px-4 py-2.5 text-left typography-markdown text-foreground"
                style={{ backgroundColor: 'var(--chat-user-message-bg)' }}>
                {text}
            </p>
        </div>,
        true,
    );
}
