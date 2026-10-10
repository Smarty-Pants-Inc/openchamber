import React from 'react';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { isOrdinaryReloading } from '@/lib/herdrSession';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSession } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChatColumnSession } from './chatColumnSession';
import { OrdinaryModelControls } from './OrdinaryModelControls';

/**
 * The composer's own model slot for an open session, before any browser-wide choice: the session's native
 * (ordinary) model, or Loading while the open session's record has not arrived (it may be ordinary; a browser
 * default shown then is a model the session does not run, smarty-code#1580). `null` means the configured picker.
 */
export function useSessionModelSlot(className?: string): React.ReactElement | null {
    const { t } = useI18n();
    const liveSessionId = useSessionUIStore(state => state.currentSessionId);
    const column = useChatColumnSession();
    const sessionId = column ? column.sessionId : liveSessionId;
    const directory = useSessionUIStore(state => sessionId ? state.getDirectoryForSession(sessionId) : undefined);
    const session = useSession(sessionId, column?.directory ?? directory ?? undefined);
    const ordinary = React.useMemo(() => readOrdinaryModel(session), [session]);
    // Keep ordinary state ahead of all historical, saved and directory-wide choices.
    if (ordinary !== undefined) {
        const target = session && sessionId ? { sessionId, directory: session.directory } : undefined;
        return <OrdinaryModelControls key={sessionId} state={ordinary} target={target} className={className}
            reloading={isOrdinaryReloading(session)} />;
    }
    if (sessionId && !session) {
        return <div className={cn('flex min-w-0 items-center typography-meta text-muted-foreground', className)}
            aria-live="polite" aria-busy="true"><span>{t('common.loading')}</span></div>;
    }
    return null;
}
