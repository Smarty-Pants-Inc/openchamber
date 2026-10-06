// smarty-code#1407: the Feed's plain pieces: a notice line, and the transcript (oldest at the top, each entry with its
// time, kept scrolled to the newest at the bottom while the person is reading there).
import React from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { formatTimestampForDisplay } from '@/components/chat/message/timeFormat';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { FeedEntry } from './feedEntries';

export function FeedNotice({ children, alert, action }: { children: React.ReactNode; alert?: boolean; action?: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p role={alert ? 'alert' : undefined} className={cn('typography-ui-label', alert ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>{children}</p>
      {action}
    </div>
  );
}

/** How close to the bottom (px) still counts as reading the newest entry. */
const PINNED_SLACK = 48;

export function FeedTranscript({ entries, name, working, loading, failed, onRetry }: {
  entries: readonly FeedEntry[]; name: string; working: boolean; loading: boolean; failed: boolean; onRetry: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true);
  const newest = entries.at(-1);
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [entries.length, newest?.text, working]);

  if (failed && entries.length === 0) {
    return <FeedNotice alert action={<Button size="sm" variant="outline" onClick={onRetry}>{t('feed.retry')}</Button>}>{t('feed.historyFailed')}</FeedNotice>;
  }
  if (loading && entries.length === 0) return <FeedNotice>{t('feed.loading')}</FeedNotice>;
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto"
      onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK; }}>
      <ol aria-label={t('feed.transcript', { name })} className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-6">
        {entries.length === 0 ? <li className="typography-ui-label text-muted-foreground">{t('feed.empty')}</li> : null}
        {entries.map(entry => (
          <li key={entry.id} data-feed-entry={entry.role} className={cn('flex min-w-0 flex-col gap-1', entry.role === 'user' && 'items-end')}>
            <div className="flex items-baseline gap-2 typography-micro text-muted-foreground">
              <span className="font-semibold text-foreground">{entry.role === 'user' ? t('feed.you') : name}</span>
              <time dateTime={new Date(entry.time).toISOString()}>{formatTimestampForDisplay(entry.time, timeFormat)}</time>
            </div>
            <div className={cn('min-w-0 max-w-full text-foreground', entry.role === 'user' && 'rounded-lg bg-[var(--surface-elevated)] px-3 py-2')}>
              <MarkdownRenderer content={entry.text} messageId={entry.id} part={entry.part} isAnimated={false} />
            </div>
          </li>
        ))}
        {working ? <li aria-live="polite" className="typography-micro text-muted-foreground">{t('feed.working', { name })}</li> : null}
        {failed && entries.length > 0 ? (
          <li role="alert" className="flex items-center gap-2 typography-micro text-[var(--status-error)]">
            {t('feed.historyFailed')}<Button size="xs" variant="outline" onClick={onRetry}>{t('feed.retry')}</Button>
          </li>) : null}
      </ol>
    </div>
  );
}
