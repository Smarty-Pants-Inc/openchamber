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
      <p>{t(native.session.nativeCreation.inputReady ? 'chat.nativeCreation.inputReady' : 'chat.nativeCreation.readiness')}</p>
    </div>;
  }
  if (!draftOpen) return null;
  if (native.creation?.status === 'pending') {
    const { operation, busy, error } = native.creation;
    const blocked = busy || Boolean(error) || !operation.generation || operation.expiresAt <= Date.now();
    return <div className="mb-2 space-y-2" role="status">
      <p>{t('chat.nativeCreation.operation', { id: operation.operationId, phase: operation.phase })}</p>
      <p className="break-words">{operation.directory}</p>
      {error ? <p role="alert">{native.describeError(error)}</p> : null}
      {operation.phase === 'awaiting-trust' ? <>
        <p>{t('chat.nativeCreation.trustNotice')}</p>
        <Button type="button" disabled={blocked} onClick={() => { void native.reply('trust'); }}>{t('chat.nativeCreation.trust')}</Button>
        <Button type="button" disabled={blocked} onClick={() => { void native.reply('deny'); }}>{t('chat.nativeCreation.deny')}</Button>
      </> : null}
      {operation.phase === 'ready-required' ? <Button type="button" disabled={blocked || !operation.canInitialReady || !operation.native}
        onClick={() => { void native.reply('ready'); }}>{t('chat.nativeCreation.ready')}</Button> : null}
      {['starting', 'awaiting-trust', 'ready-required'].includes(operation.phase) ? <Button type="button" disabled={blocked}
        onClick={() => { void native.reply('cancel'); }}>{t('chat.nativeCreation.cancel')}</Button> : null}
      <Button type="button" variant="outline" disabled={busy} onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.reread')}</Button>
    </div>;
  }
  if ((native.operations?.length ?? 0) > 0 && (!native.creation || native.creation.status === 'failed' && native.creation.submitted)) {
    return <div className="mb-2 space-y-2">
      <p>{t('chat.nativeCreation.recover')}</p>
      {native.operations.map(operation => <Button key={operation.operationId} type="button" variant="outline"
        onClick={() => { void native.resume(operation); }}>{operation.operationId} · {operation.phase}</Button>)}
      {native.canCreate ? <Button type="button" onClick={() => { void native.create(); }}>{t('chat.nativeCreation.action')}</Button> : null}
    </div>;
  }
  if (native.creation?.status === 'failed') return <div className="mb-2 space-y-1">
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--status-error)]">{native.describeError(native.creation.error)}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t(native.creation.submitted ? 'chat.nativeCreation.reread' : 'chat.nativeCreation.check')}</Button>
  </div>;
  if (native.mode === 'legacy' && !native.creation) return null;
  if (native.mode === 'loading' || native.creation?.status === 'creating' || native.creation?.status === 'checking') return <p role="status" className="mb-2 text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (native.mode === 'unavailable') return <div className="mb-2 space-y-1">
    <p role="alert" className="text-sm text-muted-foreground">{t('chat.nativeCreation.unavailable')}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { void native.refresh(); }}>{t('chat.nativeCreation.check')}</Button>
  </div>;
  return <div className="mb-2 space-y-1">
    <Button type="button" size="sm" disabled={!native.canCreate} onClick={() => { void native.create(); }}>
      {t('chat.nativeCreation.action')}
    </Button>
    {!native.canCreate && !native.creation ? <p className="text-sm text-muted-foreground">{t('chat.nativeCreation.target')}</p> : null}
  </div>;
}
