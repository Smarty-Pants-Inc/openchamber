import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ownNativeRequestId, startNativeDraftAgain, startNativeDraftInstead, useNativeDraftStarting, useUnresolvedNativeStart } from '@/sync/native-draft-start';
import { isSentStartStopped, keepSentTextAsDraft, releaseSentStart, resolveSentStart, sentStartRequest, sentStartStopperSubject, sentStartStoppedBy, type SentStartOutcome } from '@/sync/native-draft-sent';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { startsElsewhere, STOPPED_PHASES } from '@/sync/native-draft-creation';
import { abandonedNativeCreations, stopBlockingStart, stoppableAt } from '@/sync/native-draft-control';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import React from 'react';
import type { useNativeCreation } from '../state/useNativeCreation';
import { useHumanSelfSubject } from '@/lib/humanSelf';

const CANCELLABLE = ['starting', 'awaiting-trust', 'ready-required'];
const STOPPED_LINE = { expired: 'chat.nativeCreation.sentExpired', denied: 'chat.nativeCreation.sentDenied',
  cancelled: 'chat.nativeCreation.sentCancelled' } as const;
/** A start past trust is a real session: the server refuses to abandon it (smarty-code#340). */
const PAST_TRUST = ['starting', 'ready-required', 'ready'];

/**
 * A new-session draft needs no separate step: Send starts the session and then sends (smarty-code#126).
 * This line only says what is happening, or what went wrong and what to do, in plain words.
 */
export function NativeCreationNotice({ native, draftOpen, sent = null, onSend }: {
  native: ReturnType<typeof useNativeCreation>; draftOpen: boolean; sent?: SentStartOutcome | null; onSend?: () => void;
}) {
  const { t } = useI18n();
  const starting = useNativeDraftStarting();
  const draft = useSessionUIStore(state => state.newSessionDraft);
  const unresolved = useUnresolvedNativeStart(draft, getRuntimeKey());
  // Never a dead end (smarty-code#126): an unknown start offers one explicit way to start a new session anyway.
  const escape = <>
    <p className="text-sm text-muted-foreground">{t('chat.nativeCreation.startAgainHint')}</p>
    <Button type="button" size="sm" onClick={() => { startNativeDraftAgain(); onSend?.(); }}>{t('chat.nativeCreation.startAgain')}</Button>
  </>;
  const creation = native.creation;
  // A start that blocks this project and does not finish can be stopped (smarty-code#523), never a dead end: at once
  // past its expiry, else after a grace. Its text, if held here as sent, comes back (cancelled).
  const [stop, setStop] = React.useState<{ id: string; busy: boolean; error?: unknown } | null>(null);
  const [, tick] = React.useReducer((value: number) => value + 1, 0);
  const blocking = startsElsewhere(native.operations.filter(operation => !abandonedNativeCreations.has(operation.operationId)), getRuntimeKey());
  const lockedRequest = sent && draft.directoryOverride ? sentStartRequest(getRuntimeKey(), draft.directoryOverride) : undefined;
  const stoppedBy = draft.directoryOverride ? sentStartStoppedBy(getRuntimeKey(), draft.directoryOverride) : undefined;
  // smarty-code#849: a stop by the person themself reads "You stopped this start", on both paths; another person is named.
  const self = useHumanSelfSubject();
  const stoppedByYou = !!self && !!draft.directoryOverride && sentStartStopperSubject(getRuntimeKey(), draft.directoryOverride) === self;
  const stoppable = (lockedRequest ? blocking.filter(operation => operation.clientRequestId === lockedRequest) : blocking)[0];
  const stopAt = native.canAbandon && stoppable ? stoppableAt(stoppable) : undefined;
  // This draft's OWN start that does not finish (smarty-code#587: its shell frozen, the person saw only "Starting…" and
  // a greyed Cancel): the same Stop after the same threshold as a blocking start.
  const own = creation?.status === 'pending' && !STOPPED_PHASES.includes(creation.operation.phase) && creation.operation.phase !== 'ready'
    ? creation.operation : undefined;
  const ownStopAt = native.canAbandon && own ? stoppableAt(own) : undefined;
  React.useEffect(() => {
    const next = [stopAt, ownStopAt].filter((at): at is number => at !== undefined && at > Date.now());
    if (!next.length) return;
    const timer = setTimeout(tick, Math.min(...next) - Date.now() + 10);
    return () => clearTimeout(timer);
  }, [stopAt, ownStopAt]);
  const stopControl = (operation: NativeCreationState | undefined, at = stopAt) => {
    if (!operation || at === undefined || at > Date.now()) return null;
    const busy = stop?.id === operation.operationId && stop.busy;
    const failed = stop?.id === operation.operationId && !stop.busy && stop.error !== undefined ? stop.error : undefined;
    return <>
      {failed !== undefined ? <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(failed)}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={busy} title={operation.operationId}
        data-operation-id={operation.operationId} onClick={() => {
        setStop({ id: operation.operationId, busy: true });
        void stopBlockingStart(operation).then(async () => {
          setStop(null);
          const key = getRuntimeKey(), directory = draft.directoryOverride;
          // The person's own explicit Stop settled the start this draft's sent text belongs to (smarty-code#523, 3.45):
          // this tab no longer continues it, so it is read now and the text comes back, not left locked until "check
          // again" (the own-request exemption is for a start this tab still sends through).
          const mine = !!directory && operation.clientRequestId !== undefined && sentStartRequest(key, directory) === operation.clientRequestId;
          if (mine) await releaseSentStart(operation.clientRequestId); // The browser lock is gone before the read below.
          if (directory) void resolveSentStart(key, directory, draft.draftId, mine ? undefined : ownNativeRequestId(draft, key));
          native.refresh();
        }, error => setStop({ id: operation.operationId, busy: false, error }));
      }}>{t('chat.nativeCreation.stopStart')}</Button>
    </>;
  };
  if (!draftOpen) return null;
  // Text another tab sent to start a session (#117): say what became of it before anything else, with or without a
  // session here (the composer is locked meanwhile, so its way out is always shown).
  const runtimeKey = getRuntimeKey(), directory = draft.directoryOverride;
  if (sent && directory) {
    // Not sent, and why: the text is back in the draft, editable (#117).
    if (isSentStartStopped(sent)) return <p role="alert" className="mb-2 text-sm text-[var(--status-error)]">
      {sent === 'cancelled' && stoppedByYou ? t('chat.nativeCreation.stoppedByYou')
        : sent === 'cancelled' && stoppedBy ? t('chat.nativeCreation.sentStoppedBy', { name: stoppedBy }) : t(STOPPED_LINE[sent])}</p>;
    return <div className="mb-2 space-y-1">
      <p role="status" className="text-sm text-muted-foreground">{t('chat.nativeCreation.sentPending')}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={sent === 'resolving'}
          onClick={() => { void resolveSentStart(runtimeKey, directory, draft.draftId, ownNativeRequestId(draft, runtimeKey)); }}>{t('chat.nativeCreation.check')}</Button>
        {sent === 'unknown' ? <Button type="button" variant="outline" size="sm"
          onClick={() => { void keepSentTextAsDraft(runtimeKey, directory); }}>{t('chat.nativeCreation.sentKeep')}</Button> : null}
        {stopControl(stoppable)}
      </div>
    </div>;
  }
  // The session started, but its first message could not be sent (smarty-dev#856: never silent): say why; the text is
  // still in the composer, and Send sends it to this session.
  if (native.session && native.refusal && !starting) return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(native.refusal)}</p>
  </div>;
  if (native.session) return null;
  // The same rule Send refuses by, so the line and the refusal agree (smarty-code#114).
  const running = blocking;
  // A known pre-submit failure started nothing. Once the project check confirms withdrawal, say why Send is blocked
  // rather than keeping a connection error and a recheck that cannot recover this target (smarty-code#1118).
  if (native.mode === 'notAdmitted' && !starting && creation?.status === 'failed' && creation.submitted === false) {
    return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.notAdmitted')}</p>;
  }
  const failure = creation?.status === 'failed' ? creation.error : creation?.status === 'pending' ? creation.error : undefined;
  const unknown = creation?.status === 'failed' && creation.submitted;
  if (failure) return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(failure)}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
    {unknown ? escape : null}
    {/* The wait gave up (its limit) but the start is still unsettled: its Stop stays (smarty-code#587 review). */}
    {stopControl(own, ownStopAt)}
  </div>;
  // After a reload the unknown outcome has no record, only this tab's saved request.
  if (unresolved && !creation && !starting) return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-[var(--status-error)]">{t('chat.nativeCreation.unknown')}</p>
    {escape}
  </div>;
  // Send was refused before anything was sent (smarty-code#114: never a silent Send): say why until the next Send. A
  // start of this draft's own has its own line and controls (above and below), which say more.
  // openchamber#441 r2: a refusal from before anything was sent yields to the project-unavailable line once the draft's
  // project is known to be withdrawn (Send is blocked then, so the refusal could never be cleared by another press).
  if (native.refusal && !creation && !starting && native.mode === 'notAdmitted') {
    return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.notAdmitted')}</p>;
  }
  if (native.refusal && !creation && !starting) return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(native.refusal)}</p>
    {/* A Send refused by the start that blocks this project keeps the way to stop it (smarty-code#523). */}
    {stopControl(stoppable)}
  </div>;
  // A start that stopped without a session (failed before launch, declined, expired: smarty-code#634) started nothing:
  // say so. The text stays here, and the next Send clears this start and tries anew (native-draft-start).
  if (creation?.status === 'pending' && STOPPED_PHASES.includes(creation.operation.phase)) {
    // smarty-code#751: an expired start names what it was waiting for (for example text typed in its terminal).
    const reason = creation.operation.phase === 'expired' ? creation.operation.waitingFor : undefined;
    const ownStop = creation.operation.phase === 'cancelled' && !!self && creation.operation.stoppedBy?.subject === self;
    return <p role="alert" className="mb-2 text-sm text-[var(--status-error)]">{t(ownStop ? 'chat.nativeCreation.stoppedByYou' : 'chat.nativeCreation.stopped')}
      {reason ? <> {t('chat.nativeCreation.stoppedWaiting', { reason })}</> : null}</p>;
  }
  if (starting || creation?.status === 'creating' || creation?.status === 'checking') {
    return <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <p>{t('chat.nativeCreation.starting')}</p>
      {creation?.status === 'pending' && CANCELLABLE.includes(creation.operation.phase) ? <Button type="button" variant="outline" size="sm"
        disabled={creation.busy || creation.unreadable} onClick={() => { void native.cancel(); }}>{t('chat.nativeCreation.cancel')}</Button> : null}
      {/* A start that does not finish is never a dead end (smarty-code#587): Stop, as for a blocking start (#523). */}
      {stopControl(own, ownStopAt)}
    </div>;
  }
  // Send stopped while the start could not be read (smarty-code#126): its outcome is unknown. Check again only reads.
  // A server that can abandon it for good (smarty-code#340) also offers starting a new session instead; without that,
  // leaving it behind would only strand the next Send (the server refuses a second start while this one is unsettled).
  if (creation?.status === 'pending' && (creation.unreadable || creation.operation.phase === 'unavailable')) {
    return <div className="mb-2 space-y-1">
      <p role="alert" className="text-sm text-[var(--status-error)]">{t('chat.nativeCreation.unknown')}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={creation.busy} onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
        {native.canAbandon && !PAST_TRUST.includes(creation.operation.phase) ? <Button type="button" size="sm" disabled={creation.busy}
          onClick={() => { void startNativeDraftInstead().then(started => { if (started) onSend?.(); },
            error => { toast.error(native.describeError(error)); void native.refresh(); }); }}>
          {t('chat.nativeCreation.startAgain')}</Button> : null}
        {stopControl(own, ownStopAt)}
      </div>
    </div>;
  }
  if (creation?.status === 'pending') {
    return <div className="mb-2 space-y-1">
      <p role="status" className="text-sm text-muted-foreground">{t('chat.nativeCreation.recover')}</p>
      {stopControl(own, ownStopAt)}
    </div>;
  }
  if (running.length > 0) return <div className="mb-2 space-y-1">
    <p role="status" className="text-sm text-muted-foreground">{t('chat.nativeCreation.elsewhere')}</p>
    {stopControl(stoppable)}
  </div>;
  // Projects are still being discovered (the server may be slow): say so, never "cannot reach the server".
  if (native.mode === 'discovering') return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.discovering')}</p>;
  if (native.mode === 'notAdmitted') return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.notAdmitted')}</p>;
  if (native.mode === 'unavailable') return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-muted-foreground">{t('chat.nativeCreation.offline')}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  return null;
}
