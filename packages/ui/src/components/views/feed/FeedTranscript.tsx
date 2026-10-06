// smarty-code#1407: the Feed's plain pieces: a notice line, and the transcript (oldest at the top, kept scrolled to the
// newest at the bottom while the person is reading there). Each entry has a sender mark (who and when) over the chat's
// own message component, so it renders everything the chat renders: Markdown, code blocks with copy, links, tables,
// images and file attachments.
import React from 'react';
import { Button } from '@/components/ui/button';
import ChatMessage from '@/components/chat/ChatMessage';
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

export function FeedTranscript({ entries, name, working, loading, failed, onRetry, scrollerRef }: {
  entries: readonly FeedEntry[]; name: string; working: boolean; loading: boolean; failed: boolean; onRetry: () => void;
  scrollerRef?: React.RefObject<HTMLDivElement | null>;
}): React.ReactNode {
  const { t } = useI18n();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const ownScroller = React.useRef<HTMLDivElement | null>(null);
  const scroller = scrollerRef ?? ownScroller;
  const pinned = React.useRef(true);
  const newest = entries.at(-1);
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [entries.length, newest?.message, scroller, working]);

  if (failed && entries.length === 0) {
    return <FeedNotice alert action={<Button size="sm" variant="outline" onClick={onRetry}>{t('feed.retry')}</Button>}>{t('feed.historyFailed')}</FeedNotice>;
  }
  if (loading && entries.length === 0) return <FeedNotice>{t('feed.loading')}</FeedNotice>;
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto"
      onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK; }}>
      <ol aria-label={t('feed.transcript', { name })} className="flex w-full flex-col gap-4 py-6">
        {entries.length === 0 ? <li className="chat-message-column typography-ui-label text-muted-foreground">{t('feed.empty')}</li> : null}
        {entries.map(entry => (
          <li key={entry.id} data-feed-entry={entry.role} data-feed-message-id={entry.id} className="flex min-w-0 flex-col">
            <div className={cn('chat-message-column flex items-baseline gap-2 typography-ui-label', entry.role === 'user' && 'justify-end')}>
              <span className="font-semibold text-foreground">{entry.role === 'user' ? t('feed.you') : name}</span>
              <time className="tabular-nums text-muted-foreground" dateTime={new Date(entry.time).toISOString()}>{formatTimestampForDisplay(entry.time, timeFormat)}</time>
            </div>
            <ChatMessage message={entry.message} />
          </li>
        ))}
        {working ? <li aria-live="polite" className="chat-message-column typography-ui-label text-muted-foreground">{t('feed.working', { name })}</li> : null}
        {failed && entries.length > 0 ? (
          <li role="alert" className="chat-message-column flex items-center gap-2 typography-micro text-[var(--status-error)]">
            {t('feed.historyFailed')}<Button size="xs" variant="outline" onClick={onRetry}>{t('feed.retry')}</Button>
          </li>) : null}
      </ol>
    </div>
  );
}
