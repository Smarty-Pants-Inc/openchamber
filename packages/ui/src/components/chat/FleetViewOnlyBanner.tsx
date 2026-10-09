import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { checkContinue, continueEndedSession, useContinueStatus } from '@/sync/native-session-resume';
import { PiVoiceControl } from './PiVoiceControl';

/** Smarty gateway (#181): an unenrolled fleet session is shown read-only until it is enrolled. */
export const FLEET_ENROLLMENT_URL = 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/116';

/**
 * `noIdentity`: a Pi without a reported session identity is still starting (smarty-code#126 (c)3, #863).
 * `ended`: a Code-created session whose Pi has ended is read from its transcript; say so plainly and, with `resume`,
 * offer to continue it in a new Pi (smarty-code#365), following that start until the view turns live.
 * `voice`: the session's Voice call control (smarty-code#1192). A session Code only reads may still take a call; the
 * gateway's per-session voice status decides, and a "no" shows as the disabled chip with its plain reason.
 */
export const FleetViewOnlyBanner: React.FC<{ noIdentity?: boolean; ended?: boolean; reloading?: boolean;
    resume?: { directory: string; sessionID: string; project: string; available: boolean };
    voice?: { sessionId: string; directory: string } }> = ({ noIdentity = false, ended = false, reloading = false, resume, voice }) => {
    const { t } = useI18n();
    const status = useContinueStatus(resume?.sessionID, resume?.directory);
    const run = (work: (directory: string, sessionID: string) => Promise<void>) => {
        if (!resume || (work === continueEndedSession && !resume.available)) return;
        // Only a refusal the server explained arrives here (still running, open in a tab); nothing is retried.
        void work(resume.directory, resume.sessionID).catch(error => {
            toast.error(error instanceof NativeCreationError && error.detail !== undefined
                ? error.detail : t('sessions.sidebar.herdr.continueUnknown'));
        });
    };
    const project = { project: resume?.project ?? '' };
    // Continue is offered again only where no start is known to be running: never after a reply that was lost.
    const canContinue = resume?.available === true
        && (!status || status.status === 'stopped' || (status.status === 'unknown' && status.checked === true));
    return (
        <div className="w-full py-3" data-testid="fleet-view-only">
            <div className="chat-input-column">
                <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {ended || status ? <>
                        {t('sessions.sidebar.herdr.ended')}
                        {resume ? <div className="mt-2 space-y-1">
                            {status?.status === 'starting' ? <p role="status">{t('sessions.sidebar.herdr.continueStarting', project)}</p> : null}
                            {status?.status === 'unknown' ? <p role="alert">{t(status.checked
                                ? 'sessions.sidebar.herdr.continueNotFound' : 'sessions.sidebar.herdr.continueUnknown')}</p> : null}
                            {status?.status === 'stopped' ? <p role="alert">{t('sessions.sidebar.herdr.continueStopped')}</p> : null}
                            <div className="flex justify-center gap-2">
                                {status?.status === 'unknown' ? <Button type="button" size="sm" variant="outline" onClick={() => run(checkContinue)}>
                                    {t('sessions.sidebar.herdr.continueCheck')}</Button> : null}
                                {canContinue ? <Button type="button" size="sm" onClick={() => run(continueEndedSession)}>
                                    {t('sessions.sidebar.herdr.continue')}</Button> : null}
                            </div>
                            {/* What it does, in plain words, as Send's context says where a message goes. */}
                            {canContinue ? <p className="typography-micro">{t('sessions.sidebar.herdr.continueHint', project)}</p> : null}
                        </div> : null}
                    </> : reloading ? t('sessions.sidebar.herdr.reloading') : noIdentity ? t('sessions.sidebar.herdr.noIdentity') : (
                        <>
                            {t('chat.fleetView.banner')}{' '}
                            <a className="text-primary underline underline-offset-2" href={FLEET_ENROLLMENT_URL} target="_blank" rel="noopener noreferrer">
                                {t('chat.fleetView.enroll')}
                            </a>
                        </>
                    )}
                    {voice && !ended && !status ? <div className="mt-2 flex justify-center empty:hidden">
                        <PiVoiceControl sessionId={voice.sessionId} directory={voice.directory} />
                    </div> : null}
                </div>
            </div>
        </div>
    );
};
