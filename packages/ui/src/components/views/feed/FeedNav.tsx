// smarty-code#1407: the nav's Smarties: a "Smarties" section at the top of the sidebar (one row per Smarty the person
// may see, theirs first and selected on load), the one bottom button that switches to the old Smarty Code view and
// back, and on a phone the sessions sheet's button back to the Smarties.
// smarty-code#1477: the person's own Smarty comes first, under its own "Your Smarty" heading, with an accent and a
// label that names it as theirs; the others follow under "Smarties". A person with no own Smarty sees only "Smarties".
import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { Smarty } from '@/lib/smarties';
import { ensureSmartiesLoaded, openFeedPage, useFeedStore } from './feedStore';

const rowClass = 'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const headingClass = 'px-1.5 pb-0.5 pt-1 typography-micro font-semibold text-muted-foreground';

function SmartyRow({ smarty, selected }: { smarty: Smarty; selected: boolean }): React.ReactNode {
  const { t } = useI18n();
  return (
    <li>
      <button type="button" aria-current={selected ? 'page' : undefined} data-smarty-row={smarty.id} data-smarty-own={smarty.own ? '' : undefined}
        aria-label={smarty.own ? t('feed.nav.ownRow', { name: smarty.label }) : undefined}
        onClick={() => { useUIStore.getState().closeMainSurfaces(); useFeedStore.getState().selectSmarty(smarty.id); openFeedPage(); }}
        className={cn(rowClass, selected ? 'bg-interactive-selection text-interactive-selection-foreground' : smarty.own ? 'text-foreground hover:bg-interactive-hover' : 'text-muted-foreground hover:text-foreground')}>
        <Icon name="chat-ai-3" className={cn('h-4 w-4 flex-shrink-0', smarty.own && !selected && 'text-primary')} />
        <span className={cn('truncate', smarty.own && 'font-medium')}>{smarty.label}</span>
      </button>
    </li>
  );
}

export function SmartiesNavSection(): React.ReactNode {
  const { t } = useI18n();
  const smarties = useFeedStore(state => state.smarties);
  const selectedId = useFeedStore(state => state.selectedId);
  const pageOpen = useFeedStore(state => state.pageOpen);
  React.useEffect(() => { void ensureSmartiesLoaded(); }, []);
  if (smarties.state === 'unavailable' || smarties.state === 'loading') return null;
  const listed = smarties.state === 'ready' ? smarties.smarties : [];
  const own = listed.filter(smarty => smarty.own), others = listed.filter(smarty => !smarty.own);
  const row = (smarty: Smarty) => <SmartyRow key={smarty.id} smarty={smarty} selected={pageOpen && smarty.id === selectedId} />;
  return (
    <nav aria-label={t('feed.nav.label')} className="mb-1">
      {smarties.state === 'ready' ? null : <h2 className={headingClass}>{t('feed.nav.label')}</h2>}
      {smarties.state === 'failed' ? (
        <p role="alert" className="flex items-center gap-2 px-1.5 py-1 typography-micro text-[var(--status-error)]">
          {t('feed.smartiesFailed')}<Button size="xs" variant="outline" onClick={() => void ensureSmartiesLoaded(undefined, true)}>{t('feed.retry')}</Button>
        </p>
      ) : smarties.state === 'empty' ? (
        <p className="px-1.5 py-1 typography-micro text-muted-foreground">{t('feed.smartiesEmpty')}</p>
      ) : <>
        {own.length ? <><h2 className={headingClass}>{t('feed.nav.own')}</h2><ul>{own.map(row)}</ul></> : null}
        {others.length ? <><h2 className={headingClass}>{t('feed.nav.label')}</h2><ul>{others.map(row)}</ul></> : null}
      </>}
    </nav>
  );
}

/** The one button at the bottom of the nav: the old Smarty Code view (sessions, projects, fleet), and back. */
export function ClassicViewToggle(): React.ReactNode {
  const { t } = useI18n();
  const available = useFeedStore(state => state.smarties.state !== 'unavailable');
  const classicShown = useFeedStore(state => !state.pageOpen);
  if (!available) return null;
  return (
    <Button type="button" variant="ghost" size="sm" aria-pressed={classicShown} className="w-full justify-start"
      onClick={() => { useUIStore.getState().closeMainSurfaces(); if (classicShown) openFeedPage(); else useFeedStore.getState().showClassic(); }}>
      <Icon name={classicShown ? 'chat-ai-3' : 'code-box'} className="size-4" />
      {classicShown ? t('feed.classic.hide') : t('feed.classic.show')}
    </Button>
  );
}

/** The phone's sessions sheet: back to the Smarties. `onOpen` closes the sheet the button sits in. */
export function FeedMenuButton({ onOpen }: { onOpen: () => void }): React.ReactNode {
  const { t } = useI18n();
  const available = useFeedStore(state => state.smarties.state !== 'unavailable');
  React.useEffect(() => { void ensureSmartiesLoaded(); }, []);
  if (!available) return null;
  return (
    <Button type="button" variant="default" size="lg" className="w-10 px-0" aria-label={t('feed.classic.hide')} title={t('feed.classic.hide')}
      onClick={() => { openFeedPage(); onOpen(); }} style={{ touchAction: 'manipulation' }}>
      <Icon name="chat-ai-3" className="size-5" />
    </Button>
  );
}
