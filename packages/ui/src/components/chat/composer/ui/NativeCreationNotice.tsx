import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { useNativeCreation } from '../state/useNativeCreation';

export function NativeCreationNotice({ native, draftOpen }: {
  native: ReturnType<typeof useNativeCreation>; draftOpen: boolean;
}) {
  const { t } = useI18n();
  if (native.session) {
    const { id, nativeCreation: { model } } = native.session;
    return <div className="mb-2 space-y-1 text-sm text-muted-foreground" role="status">
      <p className="break-words">{t('chat.nativeCreation.created', { id, model: `${model.providerID}/${model.modelID}` })}</p>
      <p>{t('chat.nativeCreation.readiness')}</p>
    </div>;
  }
  if (!draftOpen) return null;
  if (native.creation?.status === 'failed') return <p role="alert" className="mb-2 whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">
    {native.describeError(native.creation.error)}
  </p>;
  if (native.mode === 'legacy' && !native.creation) return null;
  if (native.mode === 'loading' || native.creation?.status === 'creating') return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (native.mode === 'unavailable') return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-muted-foreground">{t('chat.nativeCreation.unavailable')}</p>
    <Button type="button" variant="outline" size="sm" onClick={native.refresh}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  return <div className="mb-2 space-y-1">
    <Button type="button" size="sm" disabled={!native.canCreate} onClick={() => { void native.create(); }}>
      {t('chat.nativeCreation.action')}
    </Button>
    {!native.canCreate && !native.creation ? <p className="text-sm text-muted-foreground">{t('chat.nativeCreation.target')}</p> : null}
  </div>;
}
