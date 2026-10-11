// smarty-code#1525: the producer writes a reply's thinking as a block of its own (`kind: 'thinking'`) just before the
// reply, with the same author and time. The transcript shows it only there: a closed native disclosure under that reply.
// Thinking anywhere else (no reply after it, another author or time, before a person's line) shows nowhere.
import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { SmartyBlock } from '@/lib/smarties';

export const isThinkingBlock = (block: SmartyBlock) => block.kind === 'thinking';

const isThinkingFor = (previous: SmartyBlock | undefined, block: SmartyBlock | undefined): previous is SmartyBlock => Boolean(previous && block
  && isThinkingBlock(previous) && !isThinkingBlock(block) && block.author === 'org' && previous.author === block.author && previous.at === block.at);

/** Each Smarty reply's thinking, by reply id: only the block right before it. */
export function thinkingByReply(blocks: readonly SmartyBlock[]): ReadonlyMap<string, SmartyBlock> {
  const pairs = new Map<string, SmartyBlock>();
  blocks.forEach((block, index) => { const previous = blocks[index - 1]; if (isThinkingFor(previous, block)) pairs.set(block.id, previous); });
  return pairs;
}

/**
 * Where the newest `shown` held blocks start, one earlier when the first is a reply whose thinking is held just above
 * it (a page boundary, or a reader's leading thought): that reply keeps its own thinking, never another.
 */
export function firstShownIndex(blocks: readonly SmartyBlock[], shown: number): number {
  const start = Math.max(0, blocks.length - shown);
  return start > 0 && isThinkingFor(blocks[start - 1], blocks[start]) ? start - 1 : start;
}

export function ThinkingDisclosure({ block, Text }: { block: SmartyBlock; Text: React.ComponentType<{ content: string }> }): React.ReactNode {
  const { t } = useI18n();
  return (
    <details data-feed-thinking className="min-w-0 typography-ui-label text-muted-foreground">
      <summary className="cursor-pointer select-none">{t('feed.thinking.summary')}</summary>
      <div className="mt-1 rounded-lg bg-muted/40 px-3 py-2"><Text content={block.text} /></div>
    </details>
  );
}

/** "Responses only" or "Show the work" (the default): whether the replies' Thinking disclosures show. */
export function FeedWorkToggle({ showWork, onChange }: { showWork: boolean; onChange: (showWork: boolean) => void }): React.ReactNode {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t('feed.work.label')} className="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="chip" aria-pressed={!showWork} onClick={() => onChange(false)}>{t('feed.work.responses')}</Button>
      <Button size="sm" variant="chip" aria-pressed={showWork} onClick={() => onChange(true)}>{t('feed.work.show')}</Button>
    </div>
  );
}
