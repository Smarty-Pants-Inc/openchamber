// smarty-code#701: the person's inbox (code-design's mock on #701): Open / Snoozed / Resolved; an item shows why, the
// recommendation, links and only the actions it allows. Accept resolves at once, with Undo (reopen) for ~5 s.
import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { actOnInboxItem, inboxItemState, loadInbox, refreshInboxBadge, safeLink, useInboxStore, type InboxAction, type InboxItem, type InboxState } from '@/lib/smartyInbox';

const TABS: { state: InboxState; label: string }[] = [{ state: 'open', label: 'Open' }, { state: 'snoozed', label: 'Snoozed' }, { state: 'resolved', label: 'Resolved' }];
const SNOOZES = [['1h', '1 hour'], ['4h', '4 hours'], ['1d', '1 day'], ['1w', '1 week']] as const;
const age = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function InboxView({ onClose, compact }: { onClose: () => void; compact?: boolean }): React.ReactNode {
  const openCount = useInboxStore(s => s.openCount), revision = useInboxStore(s => s.revision);
  const [tab, setTab] = React.useState<InboxState>('open');
  const [items, setItems] = React.useState<InboxItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Only the latest request for the tab shown applies (#365 review: a late Open answer must not fill Resolved). reload
  // reads the tab at call time: an action or Undo that finishes after a tab change refreshes the tab shown (round 2).
  const request = React.useRef(0), shownTab = React.useRef(tab);
  const reload = React.useCallback(() => {
    const mine = ++request.current;
    return loadInbox(shownTab.current).then(r => { if (mine === request.current) { setItems(r.items); setError(null); } },
      e => { if (mine === request.current) setError(String((e as Error).message)); });
  }, []);
  React.useEffect(() => { void reload(); }, [reload, tab, revision]);
  // The desktop shows the first item at once, and keeps it: a newer item arriving (SSE) never swaps the item (and a
  // response being typed) away (#365 review).
  React.useEffect(() => { if (!compact && selectedId === null && items?.[0]) setSelectedId(items[0].id); }, [compact, items, selectedId]);
  const selected = items?.find(i => i.id === selectedId) ?? (compact || selectedId !== null ? null : items?.[0] ?? null);

  const list = (
    <div className={cn('flex min-h-0 flex-col', !compact && 'w-[390px] shrink-0 border-r border-border')}>
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <span aria-hidden className="typography-ui-header">⚑</span>
        <h1 className="typography-ui-header font-semibold">Inbox</h1>
        <Button variant="ghost" size="icon" className="ml-auto size-8" aria-label="Close inbox" onClick={onClose}><Icon name="close" className="size-4" /></Button>
      </div>
      <div role="tablist" className="flex gap-4 border-b border-border px-4">
        {TABS.map(t => (
          <button key={t.state} type="button" role="tab" aria-selected={tab === t.state} onClick={() => { if (t.state === tab) return; shownTab.current = t.state; setTab(t.state); setSelectedId(null); setItems(null); }}
            className={cn('pb-2 typography-ui-label', tab === t.state ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground')}>
            {t.label}{t.state === 'open' ? ` ${openCount}` : ''}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="px-4 py-3 typography-ui-label text-status-error-text">{error}</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={`${tab} inbox items`}>
        {items?.length === 0 ? <li className="px-4 py-6 typography-ui-label text-muted-foreground">Nothing here.</li> : null}
        {items?.map(item => (
          <li key={item.id}>
            <button type="button" data-inbox-item={item.id} onClick={() => setSelectedId(item.id)} aria-current={selected?.id === item.id}
              className={cn('block w-full border-b border-border px-4 py-3 text-left hover:bg-interactive-hover', selected?.id === item.id && 'bg-interactive-hover',
                item.priority === 'p0' && 'border-l-2 border-l-destructive')}>
              <span className="line-clamp-2 typography-ui-label text-foreground">
                {item.priority === 'p0' ? <span className="mr-1.5 rounded bg-destructive px-1 typography-micro font-semibold text-white">P0</span> : null}
                {item.title}
              </span>
              <span className="typography-micro text-muted-foreground">{item.source ?? item.createdBy ?? 'agent'} · {age(item.created)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
  if (compact && !selected) return <div className="flex h-full flex-col bg-background">{list}</div>;
  return (
    <div className="flex h-full min-h-0 bg-background">
      {compact ? null : list}
      {selected ? <InboxItemDetail key={selected.id} item={selected} compact={compact} onBack={() => setSelectedId(null)} onChanged={reload} /> : null}
    </div>
  );
}

function InboxItemDetail({ item, compact, onBack, onChanged }: { item: InboxItem; compact?: boolean; onBack: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState<null | 'respond' | 'edit'>(null), [text, setText] = React.useState('');
  const allowed = (action: string) => item.actions.includes(action);
  const act = async (action: InboxAction, body: Record<string, string>, done?: string) => {
    setBusy(true); setError(null);
    try {
      await actOnInboxItem(item.id, action, body);
      if (action === 'answer') { setReply(null); setText(''); }
      if (done) toast.success(done, { duration: 5000, action: { label: 'Undo', onClick: () => void actOnInboxItem(item.id, 'reopen', {}).then(onChanged).then(refreshInboxBadge, e => toast.error(String((e as Error).message))) } });
      await onChanged(); void refreshInboxBadge();
    } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); }
  };
  const state = inboxItemState(item);
  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={item.title}>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        {compact ? <Button variant="ghost" size="sm" className="mb-2 -ml-2" onClick={onBack}><Icon name="arrow-left" className="size-4" />Inbox</Button> : null}
        <h2 className="typography-ui-header font-semibold text-foreground">{item.title}</h2>
        <p className="mt-1 typography-micro text-muted-foreground">from <b>{item.source ?? item.createdBy ?? 'agent'}</b> · {age(item.created)} · to {item.to}</p>
        {item.why ? <><h3 className="mt-4 typography-micro font-semibold uppercase text-muted-foreground">Why</h3><p className="mt-1 whitespace-pre-wrap typography-ui-label">{item.why}</p></> : null}
        {item.recommendation ? (
          <div className="mt-4 rounded-md border border-[var(--status-success-border,theme(colors.green.300))] bg-[var(--status-success-background,theme(colors.green.50))] p-3">
            <h3 className="typography-micro font-semibold uppercase text-[var(--status-success-text,var(--status-success,theme(colors.green.700)))]">Recommendation</h3>
            <p className="mt-1 whitespace-pre-wrap typography-ui-label">{item.recommendation}</p>
          </div>) : null}
        {item.links.length ? <><h3 className="mt-4 typography-micro font-semibold uppercase text-muted-foreground">Links</h3>
          <ul className="mt-1">{item.links.map(link => { const href = safeLink(link.url); const label = link.label ?? link.url.replace(/^https:\/\/github\.com\/[^/]+\//, '').replace(/\/(issues|pull)\//, '#');
            return <li key={link.url} className="typography-ui-label">{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary-text hover:underline">↗ {label}</a> : label}</li>; })}</ul></> : null}
        {item.answer ? <p className="mt-4 typography-micro text-muted-foreground">Answered ({item.answer.action ?? 'respond'}){item.answer.text ? `: ${item.answer.text}` : ''}</p> : null}
        {reply ? (
          <div className="mt-4">
            <Textarea aria-label={reply === 'edit' ? 'Your edit' : 'Your response'} value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus />
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => void act('answer', { text, action: reply })}>Send</Button>
              <Button size="sm" variant="ghost" onClick={() => setReply(null)}>Cancel</Button>
            </div>
          </div>) : null}
        {error ? <p role="alert" className="mt-3 typography-ui-label text-status-error-text">{error}</p> : null}
      </div>
      <div className={cn('flex flex-wrap gap-2 px-7 py-3', compact && 'border-t border-border pb-[max(0.75rem,env(safe-area-inset-bottom))]')}>
        {state === 'resolved' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('reopen', {})}>Reopen</Button> : <>
          {allowed('accept') ? <Button size="sm" disabled={busy} onClick={() => void act('resolve', { action: 'accept' }, 'Accepted')}>✓ Accept</Button> : null}
          {allowed('respond') ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setReply('respond')}>✎ Respond</Button> : null}
          {allowed('edit') ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setReply('edit')}>Edit</Button> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={busy}>Snooze ▾</Button></DropdownMenuTrigger>
            <DropdownMenuContent>{SNOOZES.map(([value, label]) => <DropdownMenuItem key={value} onSelect={() => void act('snooze', { for: value }, `Snoozed for ${label}`)}>{label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
          {allowed('ignore') ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('resolve', { action: 'ignore' }, 'Ignored')}>Ignore</Button> : null}
        </>}
      </div>
    </article>
  );
}
