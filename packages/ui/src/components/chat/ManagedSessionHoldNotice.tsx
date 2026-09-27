import React from 'react';
import { useI18n } from '@/lib/i18n';
import { managedSessionHoldExpired, MANAGED_SESSION_HOLD_MS, useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { openRegisteredSessions } from '@/apps/deepLinkNavigation';

/** The open session's project has not joined the live catalog yet (#608); after the bounded wait, say so. */
export const ManagedSessionHoldNoticeView: React.FC<{ notArrived: boolean; onShowProjects: () => void }> = ({ notArrived, onShowProjects }) => {
    const { t } = useI18n();
    return (
        <div className="w-full py-2" data-testid="managed-session-hold">
            <div className="chat-input-column">
                <div role="status" className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {notArrived ? (
                        <>
                            {t('chat.managedHold.notArrived')}{' '}
                            <button type="button" className="text-primary underline underline-offset-2" onClick={onShowProjects}>
                                {t('chat.managedHold.showProjects')}
                            </button>
                        </>
                    ) : t('chat.managedHold.waiting')}
                </div>
            </div>
        </div>
    );
};

export const ManagedSessionHoldNotice: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
    const hold = useProjectsStore((state) => state.managedSessionHold);
    // The open session held, or an open still waiting for its project (nothing selected meanwhile).
    const held = hold && (hold.sessionId === sessionId || hold.pending) ? hold : null;
    const [now, setNow] = React.useState(() => Date.now());
    // Re-render once the bounded wait ends, even if no publication arrives.
    React.useEffect(() => {
        if (!held) return;
        const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, held.since + MANAGED_SESSION_HOLD_MS - Date.now()));
        return () => window.clearTimeout(timer);
    }, [held]);
    // The mobile shell keeps its sheet in local state and registers an opener; the desktop uses the sidebar.
    const showProjects = React.useCallback(() => { if (!openRegisteredSessions()) useUIStore.getState().setSidebarOpen(true); }, []);
    if (!held) return null;
    return <ManagedSessionHoldNoticeView notArrived={managedSessionHoldExpired(held, now)} onShowProjects={showProjects} />;
};
