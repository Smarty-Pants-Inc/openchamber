import React from 'react';
import { useI18n } from '@/lib/i18n';

/** Smarty gateway (#181): an unenrolled fleet session is shown read-only until it is enrolled. */
export const FLEET_ENROLLMENT_URL = 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/116';
/** `noIdentity`: a Pi Herdr shows without a session identity has no messages to view; say why (smarty-code#126 (c)3). */
/** `ended`: a Code-created session whose Pi has ended is read from its transcript; say so plainly. */
export const FleetViewOnlyBanner: React.FC<{ noIdentity?: boolean; ended?: boolean }> = ({ noIdentity = false, ended = false }) => {
    const { t } = useI18n();
    return (
        <div className="w-full py-3" data-testid="fleet-view-only">
            <div className="chat-input-column">
                <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {ended ? t('sessions.sidebar.herdr.ended') : noIdentity ? t('sessions.sidebar.herdr.noIdentity') : (
                        <>
                            {t('chat.fleetView.banner')}{' '}
                            <a className="text-primary underline underline-offset-2" href={FLEET_ENROLLMENT_URL} target="_blank" rel="noopener noreferrer">
                                {t('chat.fleetView.enroll')}
                            </a>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
