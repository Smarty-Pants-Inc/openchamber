/**
 * The composer's send / queue / stop control.
 *
 * Which one is shown depends on whether a turn is running: idle sends, a busy
 * session with content offers both queue (above) and stop, a busy session
 * without content offers only stop.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    /** An ordinary session takes the message while its agent works (the server steers it): Send, not Queue. */
    sendWhileWorking?: boolean;
    /** Why Send is disabled although there is text (smarty-code#778: its session is unavailable), shown on hover. */
    sendDisabledReason?: string;
    onAbort: () => void;
};

export const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        onPrimaryAction,
        onQueueMessage,
        sendWhileWorking = false,
        sendDisabledReason,
        onAbort,
    } = props;
    const { t } = useI18n();

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || (!currentSessionId && !newSessionDraftOpen)}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && (currentSessionId || newSessionDraftOpen)
                    ? 'text-primary-text hover:text-primary-text'
                    : 'opacity-30'
            )}
            aria-label={t('chat.chatInput.actions.sendMessageAria')}
            title={sendDisabledReason}
        >
            <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    return (
        <div className="relative">
            {hasContent ? (
                <button
                    type="button"
                    disabled={!currentSessionId || Boolean(sendDisabledReason)}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        onQueueMessage();
                    }}
                    className={cn(
                        footerIconButtonClass,
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        currentSessionId && !sendDisabledReason ? 'text-primary-text hover:text-primary-text' : 'opacity-30'
                    )}
                    aria-label={t(sendWhileWorking ? 'chat.coSteer.sendWhileWorking' : 'chat.chatInput.actions.queueMessageAria')}
                    title={sendDisabledReason ?? (sendWhileWorking ? t('chat.coSteer.sendWhileWorking') : undefined)}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, !sendWhileWorking && '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={onAbort}
                className={cn(
                    footerIconButtonClass,
                    'text-status-error-text hover:text-status-error-text'
                )}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={cn(stopIconSizeClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.sendDisabledReason === next.sendDisabledReason
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onQueueMessage === next.onQueueMessage
    && prev.sendWhileWorking === next.sendWhileWorking
    && prev.onAbort === next.onAbort
));
