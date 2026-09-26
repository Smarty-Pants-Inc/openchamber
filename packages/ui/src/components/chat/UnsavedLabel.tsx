import { useI18n } from '@/lib/i18n';
import { isUnsaved } from './unsaved';

/** A small label on a message row that Pi has not written to the session file yet (slice 1 L1). */
export function UnsavedLabel({ info }: { info: unknown }) {
  const { t } = useI18n();
  if (!isUnsaved(info)) return null;
  return (
    <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground" title={t('chat.unsaved.detail')}>
      <span className="rounded border border-border px-1.5 py-px">{t('chat.unsaved.label')}</span>
    </div>
  );
}
