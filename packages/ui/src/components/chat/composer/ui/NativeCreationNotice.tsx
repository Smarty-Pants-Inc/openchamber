import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { startNativeDraftAgain, useNativeDraftStarting, useUnresolvedNativeStart } from '@/sync/native-draft-start';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { useNativeCreation } from '../state/useNativeCreation';

const CANCELLABLE = ['starting', 'awaiting-trust', 'ready-required'];

/**
 * A new-session draft needs no separate step: Send starts the session and then sends (smarty-code#126).
 * This line only says what is happening, or what went wrong and what to do, in plain words.
 */
export function NativeCreationNotice({ native, draftOpen, onSend }: {
  native: ReturnType<typeof useNativeCreation>; draftOpen: boolean; onSend?: () => void;
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
  if (!draftOpen || native.session) return null;
  const running = native.operations.filter(operation => CANCELLABLE.includes(operation.phase));
  const failure = creation?.status === 'failed' ? creation.error : creation?.status === 'pending' ? creation.error : undefined;
  const unknown = creation?.status === 'failed' && creation.submitted;
  if (failure) return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(failure)}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
    {unknown ? escape : null}
  </div>;
  // After a reload the unknown outcome has no record, only this tab's saved request.
  if (unresolved && !creation && !starting) return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-[var(--status-error)]">{t('chat.nativeCreation.unknown')}</p>
    {escape}
  </div>;
  if (starting || creation?.status === 'creating' || creation?.status === 'checking') {
    return <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <p>{t('chat.nativeCreation.starting')}</p>
      {creation?.status === 'pending' && CANCELLABLE.includes(creation.operation.phase) ? <Button type="button" variant="outline" size="sm"
        disabled={creation.busy || creation.unreadable} onClick={() => { void native.cancel(); }}>{t('chat.nativeCreation.cancel')}</Button> : null}
    </div>;
  }
  // Send stopped while the start could not be read (smarty-code#126): its outcome is unknown. Check again only reads.
  if (creation?.status === 'pending' && (creation.unreadable || creation.operation.phase === 'unavailable')) {
    return <div className="mb-2 space-y-1">
      <p role="alert" className="text-sm text-[var(--status-error)]">{t('chat.nativeCreation.unknown')}</p>
      <Button type="button" variant="outline" size="sm" disabled={creation.busy} onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
      {escape}
    </div>;
  }
  if (creation?.status === 'pending') {
    return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.recover')}</p>;
  }
  if (running.length > 0) return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.elsewhere')}</p>;
  if (native.mode === 'unavailable') return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-muted-foreground">{t('chat.nativeCreation.offline')}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  return null;
}
