import React from 'react';
import { useI18n } from '@/lib/i18n';

/** Smarty gateway (#181): an unenrolled fleet session is shown read-only until it is enrolled. */
export const FLEET_ENROLLMENT_URL = 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/116';
export const FleetViewOnlyBanner: React.FC = () => {
    const { t } = useI18n();
    return (
        <div className="w-full py-3" data-testid="fleet-view-only">
            <div className="chat-input-column">
                <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {t('chat.fleetView.banner')}{' '}
                    <a className="text-primary underline underline-offset-2" href={FLEET_ENROLLMENT_URL} target="_blank" rel="noreferrer">
                        {t('chat.fleetView.enroll')}
                    </a>
                </div>
            </div>
        </div>
    );
};
