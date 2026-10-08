// smarty-code#1489: the one-time "Add to Home Screen" line, below the top bar so it never covers the composer.
import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { dismissHomeScreenHint, readHomeScreenHintEnv, shouldShowHomeScreenHint } from '@/lib/homeScreenHint';

export function HomeScreenHint(): React.ReactNode {
  const { t } = useI18n();
  const [shown, setShown] = React.useState(() => shouldShowHomeScreenHint(readHomeScreenHintEnv()));
  if (!shown) return null;
  return (
    <div role="note" data-home-screen-hint=""
      className="fixed inset-x-2 z-[60] flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 typography-micro text-foreground shadow-sm"
      style={{ top: 'calc(var(--oc-safe-area-top, 0px) + var(--oc-header-height, 56px) + 0.25rem)' }}>
      <span className="min-w-0 flex-1">{t('homeScreenHint.text')}</span>
      <button type="button" aria-label={t('homeScreenHint.dismiss')} className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground"
        onClick={() => { dismissHomeScreenHint(); setShown(false); }} style={{ touchAction: 'manipulation' }}>
        <Icon name="close" className="size-4" />
      </button>
    </div>
  );
}
