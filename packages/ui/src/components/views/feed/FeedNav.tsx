// smarty-code#1407: the Feed's entries: a row in the desktop sidebar and a button in the phone menu (the sessions
// sheet's footer). Each opens the one Feed page.
import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { openFeedPage, useFeedStore } from './feedStore';

export function FeedSidebarRow(): React.ReactNode {
  const { t } = useI18n();
  const open = useFeedStore(state => state.pageOpen);
  return (
    <button type="button" aria-pressed={open}
      onClick={() => { useUIStore.getState().closeMainSurfaces(); if (open) useFeedStore.getState().setPageOpen(false); else openFeedPage(); }}
      className={cn('mt-1 flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        open ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground')}>
      <Icon name="chat-ai-3" className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">{t('feed.nav.label')}</span>
    </button>
  );
}

/** `onOpen` closes the menu the button sits in. */
export function FeedMenuButton({ onOpen }: { onOpen: () => void }): React.ReactNode {
  const { t } = useI18n();
  return (
    <Button type="button" variant="default" size="lg" className="w-10 px-0" aria-label={t('feed.nav.label')} title={t('feed.nav.label')}
      onClick={() => { openFeedPage(); onOpen(); }} style={{ touchAction: 'manipulation' }}>
      <Icon name="chat-ai-3" className="size-5" />
    </Button>
  );
}
