import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useInboxStore } from '@/lib/smartyInbox';

// Primary sidebar action: starting a session is the one control worth its own
// row; it keeps the quiet text-row form so the top reads as content, while
// every other control lives in the icon toolbar below.
type Props = {
  onNewSession: () => void;
};

export function SidebarNav(props: Props): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="select-none flex-shrink-0 px-2.5 pt-1.5">
      <button
        type="button"
        onClick={props.onNewSession}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="chat-new" className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
      </button>
      <InboxBadgeRow />
    </div>
  );
}

/** smarty-code#701: "⚑ Needs you N" (only for a person with an inbox); a click opens the inbox over the chat. */
function InboxBadgeRow(): React.ReactNode {
  const { available, openCount, p0Count, pageOpen } = useInboxStore();
  if (!available) return null;
  return (
    <button type="button" aria-pressed={pageOpen} aria-label={`Needs you: ${openCount} open${p0Count ? `, ${p0Count} P0` : ''}`}
      onClick={() => { useUIStore.getState().closeMainSurfaces(); useInboxStore.getState().setPageOpen(!pageOpen); }}
      className={cn('mt-1 flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        openCount ? 'bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)] text-[var(--primary-base)]' : 'text-muted-foreground hover:text-foreground')}>
      <span aria-hidden className="w-4 text-center">⚑</span>
      <span className="truncate">Needs you</span>
      {openCount ? <span data-inbox-count className={cn('ml-auto rounded-full px-1.5 typography-micro font-semibold text-white', p0Count ? 'bg-destructive' : 'bg-[var(--primary-base)]')}>{openCount}</span> : null}
    </button>
  );
}
