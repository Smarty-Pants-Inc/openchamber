// smarty-code#1490: at a glance, what a Smarty's agent is doing: a small dot and a word (never colour alone), its last
// activity ("2m ago"), and in an open Smarty a live "Working… 12s" line while a turn runs. Only what the gateway reported:
// a Smarty without activity (a gateway that does not report it) shows nothing, and an unknown start shows no seconds.
import React from 'react';
import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import { cn } from '@/lib/utils';
import type { SmartyActivity, SmartyState } from '@/lib/smarties';

const DOT: Record<SmartyState, string> = {
  working: 'bg-[var(--status-success)] motion-safe:animate-pulse',
  waiting: 'bg-[var(--status-warning)]',
  blocked: 'bg-[var(--status-error)]',
  idle: 'bg-muted-foreground/60',
  offline: 'border border-muted-foreground bg-transparent',
  unknown: 'border border-dashed border-muted-foreground bg-transparent',
};

/** The clock, re-read every `ms` while `on`. */
function useNow(ms: number, on = true): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
  return now;
}

/** "now", "45s ago", "2m ago", "3h ago", "2d ago" in the person's locale. */
function relativeTime(at: number, now: number, locale = getCurrentIntlLocale()): string {
  const s = Math.max(0, Math.round((now - at) / 1000)), format = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' });
  if (s < 10) return format.format(0, 'second');
  if (s < 60) return format.format(-s, 'second');
  if (s < 3600) return format.format(-Math.floor(s / 60), 'minute');
  if (s < 86_400) return format.format(-Math.floor(s / 3600), 'hour');
  return format.format(-Math.floor(s / 86_400), 'day');
}
/** "12s", "3m 04s", "1h 02m". */
function duration(ms: number, locale = getCurrentIntlLocale()): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const unit = (value: number, name: 'second' | 'minute' | 'hour', pad = false) => new Intl.NumberFormat(locale,
    { style: 'unit', unit: name, unitDisplay: 'narrow', minimumIntegerDigits: pad ? 2 : 1 }).format(value);
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return `${unit(Math.floor(s / 60), 'minute')} ${unit(s % 60, 'second', true)}`;
  return `${unit(Math.floor(s / 3600), 'hour')} ${unit(Math.floor(s / 60) % 60, 'minute', true)}`;
}

/** The dot and the word, and (with `time`) the last activity. It never shrinks: the name beside it truncates instead. */
export function SmartyStatusBadge({ activity, time = true, className }: { activity?: SmartyActivity; time?: boolean; className?: string }): React.ReactNode {
  const { t } = useI18n();
  const now = useNow(30_000, Boolean(activity && time));
  if (!activity) return null;
  const { state, lastActiveAt } = activity;
  // Every state shows its last activity, working too ("now"); the open view's ticking line stays separate (#578 review).
  const ago = time && lastActiveAt !== null ? relativeTime(lastActiveAt, now) : null;
  return (
    <span data-smarty-status={state} title={state === 'waiting' ? t('feed.status.waitingHint') : undefined}
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap typography-micro text-muted-foreground', className)}>
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[state])} />
      <span>{t(`feed.status.${state}`)}</span>
      {ago ? <span data-smarty-last-active className="tabular-nums"><span aria-hidden>· </span><span className="sr-only">{t('feed.status.lastActive')} </span>{ago}</span> : null}
    </span>
  );
}

/** "Working… 12s", ticking, while the open Smarty's turn runs; gone when it ends. No observed start: "Working…" alone. */
export function SmartyWorkingLine({ activity }: { activity?: SmartyActivity }): React.ReactNode {
  const { t } = useI18n();
  const working = activity?.state === 'working', startedAt = working ? activity.startedAt : null;
  const now = useNow(1000, startedAt !== null);
  if (!working) return null;
  return (
    // Announced once when the turn starts; the ticking seconds are not read out every second.
    <p role="status" data-smarty-working className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1 typography-micro text-muted-foreground">
      <span aria-hidden className={cn('inline-block size-2 rounded-full', DOT.working)} />
      <span>{t('feed.status.workingNow')}</span>
      {startedAt !== null ? <span aria-hidden className="tabular-nums">{duration(now - startedAt)}</span> : null}
    </p>
  );
}
