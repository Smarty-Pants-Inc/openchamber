import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { coeditConflictNoticeKey } from '@/lib/coedit/coeditData';
import type { CoeditRoom } from '@/lib/coedit/useCoeditRoom';

/**
 * smartyfs#18: the co-editing state above the Files editor: live, offline (edits merge on reconnect), or unavailable,
 * and the disk bridge's conflicts with its own recovery notice, kept until the person dismisses it.
 */
export function CoeditBar({ room }: { room: CoeditRoom }) {
    const { t } = useI18n();
    if (room.phase === 'off') return null;
    const status: Record<Exclude<CoeditRoom['phase'], 'off'>, { icon: IconName; text: string; tone: 'muted' | 'warn' }> = {
        connecting: { icon: 'loader-4', text: t('filesView.coedit.connecting'), tone: 'muted' },
        live: { icon: 'team', text: t('filesView.coedit.live'), tone: 'muted' },
        offline: { icon: 'cloud-off', text: t('filesView.coedit.offline'), tone: 'warn' },
        refused: { icon: 'error-warning', text: t('filesView.coedit.refused'), tone: 'warn' },
    };
    const current = status[room.phase];
    return (
        <div className="shrink-0 border-b border-border" data-coedit-phase={room.phase}>
            <div className={cn('flex items-center gap-2 px-3 py-1 typography-ui-meta',
                current.tone === 'warn' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
                <Icon name={current.icon} className={cn('size-3.5 shrink-0', room.phase === 'connecting' && 'animate-spin')} aria-hidden />
                <span className="truncate">{current.text}</span>
            </div>
            {room.conflict && (
                <div role="alert" data-coedit-conflict={room.conflict.kind}
                    className="flex items-start gap-2 border-t border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-ui text-[var(--status-warning-foreground)]">
                    <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">{t(coeditConflictNoticeKey(room.conflict.kind))}</span>
                    <button type="button" onClick={room.dismissConflict} className="shrink-0 underline-offset-2 hover:underline">
                        {t('filesView.coedit.dismiss')}
                    </button>
                </div>
            )}
        </div>
    );
}
