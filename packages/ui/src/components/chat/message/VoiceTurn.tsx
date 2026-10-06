import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessageEntry } from '../lib/turns/types';

import { voiceMatched, voiceRelayed, voiceSpeaker, voiceText } from './voiceTurnData';

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

/** #739: a collapsed line; one click opens it. `warn`: amber (replies the voice was given and did not say). */
function Fold({ label, warn = false, children }: { label: string; warn?: boolean; children: React.ReactNode }) {
    const [open, setOpen] = React.useState(false);
    return (
        <div className="typography-ui-meta">
            <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
                className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
                    warn ? 'bg-[var(--status-warning-background)] text-[var(--status-warning)]' : 'bg-muted/60 text-muted-foreground hover:text-foreground')}>
                <Icon name="volume-up" className="size-3.5" aria-hidden />
                <span>{label}</span>
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" aria-hidden />
            </button>
            {open && (
                <div className={cn('mt-1.5 space-y-1 whitespace-pre-wrap break-words rounded-md px-3 py-2 typography-markdown',
                    warn ? 'bg-[var(--status-warning-background)] text-foreground' : 'bg-muted/40 text-muted-foreground')}>
                    {children}
                </div>
            )}
        </div>
    );
}

export function VoiceTurn({ message }: { message: ChatMessageEntry }) {
    const { t } = useI18n();
    const speaker = voiceSpeaker(message.info);
    const text = voiceText(message.parts);
    if (!text) return null;
    const row = (children: React.ReactNode, mine = false) => (
        <div className="group w-full pt-1 pb-1" id={`message-${message.info.id}`} data-message-id={message.info.id}
            data-voice-turn={speaker}>
            <div className={cn('chat-message-column flex', mine ? 'justify-end' : 'justify-start')}>{children}</div>
        </div>
    );
    if (speaker === 'voice') {
        // #739: one turn, one message. An exact repeat of the written reply folds under it; any other spoken line
        // shows in full, with the replies the voice was given and did not say beside it.
        if (voiceMatched(message.info)) return row(<Fold label={t('chat.voiceTurn.spoken')}><p>{text}</p></Fold>);
        const relayed = voiceRelayed(message.info);
        return row(
            <div className="min-w-0 max-w-[85%] space-y-1.5">
                <p className="flex items-start gap-2 whitespace-pre-wrap break-words typography-markdown text-foreground"
                    aria-label={t('chat.voiceTurn.voice')}>
                    <Icon name="volume-up" className="mt-[0.3em] size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>{text}</span>
                </p>
                {relayed.length > 0 && (
                    <Fold warn label={t('chat.voiceTurn.notSaid', { count: relayed.length })}>
                        {relayed.map((reply, index) => <p key={index}>{reply}</p>)}
                    </Fold>
                )}
            </div>,
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
