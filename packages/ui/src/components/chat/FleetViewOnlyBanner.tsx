import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { nativeCreationFailure } from '@/lib/opencode/nativeCreation';
import { useI18n } from '@/lib/i18n';

/** Smarty gateway (#181): an unenrolled fleet session is shown read-only until it is enrolled. */
export const FLEET_ENROLLMENT_URL = 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/116';
/** `noIdentity`: a Pi Herdr shows without a session identity has no messages to view; say why (smarty-code#126 (c)3). */
/** `ended`: a Code-created session whose Pi has ended is read from its transcript; say so plainly, and offer to continue
 * it in a new Pi (smarty-code#365) when `onContinue` is given. */
export const FleetViewOnlyBanner: React.FC<{ noIdentity?: boolean; ended?: boolean; onContinue?: () => Promise<boolean>;
    project?: string }> = ({ noIdentity = false, ended = false, onContinue, project }) => {
    const { t } = useI18n();
    const [continuing, setContinuing] = React.useState(false);
    // A refusal says why in the server's own plain words (still running, open in a tab); nothing is retried.
    const start = () => {
        setContinuing(true);
        void onContinue?.().then(ready => { if (!ready) toast.info(t('sessions.sidebar.herdr.continueStarting')); }, error => {
            toast.error(nativeCreationFailure(error).detail ?? t('sessions.sidebar.herdr.continueFailed'));
        }).finally(() => setContinuing(false));
    };
    return (
        <div className="w-full py-3" data-testid="fleet-view-only">
            <div className="chat-input-column">
                <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {ended ? <>
                        {t('sessions.sidebar.herdr.ended')}
                        {onContinue ? <div className="mt-2 space-y-1">
                            <Button type="button" size="sm" disabled={continuing} onClick={start}>{t('sessions.sidebar.herdr.continue')}</Button>
                            {/* What it does, in plain words, as Send's context says where a message goes. */}
                            <p className="typography-micro">{t('sessions.sidebar.herdr.continueHint', { project: project ?? '' })}</p>
                        </div> : null}
                    </> : noIdentity ? t('sessions.sidebar.herdr.noIdentity') : (
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
