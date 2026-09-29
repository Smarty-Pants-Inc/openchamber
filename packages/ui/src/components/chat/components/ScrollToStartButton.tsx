import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** smarty-code#583: "Beginning": loads the session's first window and shows it, however long the session is. */
export function ScrollToStartButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
    const { t } = useI18n();
    return (
        <div className={cn('pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100', visible ? 'opacity-100' : 'opacity-0')}>
            <div className="chat-input-column flex justify-end">
                <button type="button" onClick={onClick} aria-label={t('chat.scrollToStart.aria')} data-scroll-to-start
                    className={cn('oc-glass-popover inline-flex h-8 items-center gap-1.5 rounded-full border border-black/[0.06] px-3 typography-ui-meta text-muted-foreground dark:border-white/[0.08]',
                        visible ? 'pointer-events-auto' : 'pointer-events-none')}>
                    <Icon name="arrow-up" className="h-4 w-4" aria-hidden />
                    <span>{t('chat.scrollToStart.label')}</span>
                </button>
            </div>
        </div>
    );
}
