import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useNativeDraftStarting } from '@/sync/native-draft-start';
import type { useNativeCreation } from '../state/useNativeCreation';

const CANCELLABLE = ['starting', 'awaiting-trust', 'ready-required'];

/**
 * A new-session draft needs no separate step: Send starts the session and then sends (smarty-code#126).
 * This line only says what is happening, or what went wrong and what to do, in plain words.
 */
export function NativeCreationNotice({ native, draftOpen }: {
  native: ReturnType<typeof useNativeCreation>; draftOpen: boolean;
}) {
  const { t } = useI18n();
  const starting = useNativeDraftStarting();
  const creation = native.creation;
  if (!draftOpen || native.session) return null;
  const running = native.operations.filter(operation => CANCELLABLE.includes(operation.phase));
  // A lost create response with exactly one start still running here: Send continues it (native-draft-start).
  const recoverable = creation?.status === 'failed' && creation.submitted && running.length === 1;
  const failure = recoverable ? undefined
    : creation?.status === 'failed' ? creation.error : creation?.status === 'pending' ? creation.error : undefined;
  if (failure) return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(failure)}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  if (starting || creation?.status === 'creating' || creation?.status === 'checking') {
    return <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <p>{t('chat.nativeCreation.starting')}</p>
      {creation?.status === 'pending' && CANCELLABLE.includes(creation.operation.phase) ? <Button type="button" variant="outline" size="sm"
        disabled={creation.busy} onClick={() => { void native.cancel(); }}>{t('chat.nativeCreation.cancel')}</Button> : null}
    </div>;
  }
  if (recoverable || creation?.status === 'pending' || running.length > 0) {
    return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('chat.nativeCreation.recover')}</p>;
  }
  if (native.mode === 'unavailable') return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-muted-foreground">{t('chat.nativeCreation.offline')}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  return null;
}
