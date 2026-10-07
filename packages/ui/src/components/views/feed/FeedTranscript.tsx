// smarty-code#1407: the Smarty view's plain pieces: a notice line, and the transcript (oldest at the top, kept scrolled to
// the newest at the bottom while the person is reading there). Each block has a sender mark (who and when) over its
// text, rendered with the chat's own Markdown renderer (code blocks with copy, links, tables).
import React from 'react';
import { Button } from '@/components/ui/button';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SmartyBlock } from '@/lib/smarties';

export function FeedNotice({ children, alert, action }: { children: React.ReactNode; alert?: boolean; action?: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p role={alert ? 'alert' : undefined} className={cn('typography-ui-label', alert ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>{children}</p>
      {action}
    </div>
  );
}

/** How close to the bottom (px) still counts as reading the newest block. */
const PINNED_SLACK = 48;

/**
 * `smartyName` names the Smarty's own blocks (author "org"); `me` is the signed-in person, shown as "You". Any other
 * author is a person, shown by name, never by an id.
 */
export type BlockText = React.ComponentType<{ content: string }>;

/** `earlier`: the "Show earlier" control, when older blocks exist. */
export function FeedTranscript({ blocks, smartyName, me, Text = SimpleMarkdownRenderer, earlier = null }: {
  blocks: readonly SmartyBlock[]; smartyName: string; me: string; Text?: BlockText;
  earlier?: { state: 'idle' | 'loading' | 'failed'; show: () => void } | null;
}): React.ReactNode {
  const { t } = useI18n();
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true);
  const newest = blocks.at(-1), oldest = blocks[0];
  const before = React.useRef<{ height: number; oldest?: string }>({ height: 0 });
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Newest at the bottom while reading there; older blocks added above keep the blocks being read in place.
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else if (before.current.oldest !== oldest?.id) element.scrollTop += element.scrollHeight - before.current.height;
    before.current = { height: element.scrollHeight, oldest: oldest?.id };
  }, [blocks.length, newest?.id, oldest?.id]);
  const authorName = (author: string) => author === 'org' ? smartyName : author === me ? t('feed.you') : author.charAt(0).toUpperCase() + author.slice(1);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto"
      onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK; }}>
      <ol aria-label={t('feed.transcript', { name: smartyName })} className="flex w-full flex-col gap-4 py-6">
        {earlier ? (
          <li className="chat-message-column flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={earlier.state === 'loading'} onClick={earlier.show}>{t('feed.earlier.show')}</Button>
            {earlier.state === 'failed' ? <span role="alert" className="typography-micro text-[var(--status-error)]">{t('feed.earlier.failed')}</span> : null}
          </li>) : null}
        {blocks.length === 0 ? <li className="chat-message-column typography-ui-label text-muted-foreground">{t('feed.empty')}</li> : null}
        {blocks.map(block => (
          <li key={block.id} data-feed-entry={block.author === 'org' ? 'smarty' : 'person'} className="chat-message-column flex min-w-0 flex-col gap-1">
            <div className="flex items-baseline gap-2 typography-ui-label">
              <span className="font-semibold text-foreground">{authorName(block.author)}</span>
              <span className="tabular-nums text-muted-foreground">{block.at}</span>
            </div>
            <Text content={block.text} />
          </li>
        ))}
      </ol>
    </div>
  );
}
