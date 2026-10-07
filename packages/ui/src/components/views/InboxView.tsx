// smarty-code#701: the person's inbox (code-design's mock on #701): Open / Snoozed / Resolved; an item shows why, the
// recommendation and only the actions it allows. Accept resolves at once, with Undo (reopen) for ~5 s.
// smarty-code#1407 item 6 (R-plain-english, smarty-dev#2264): a card shows only the plain title, the why and the
// recommendation; evidence sits behind one Details link (the item's first safe link). `ownerName` names the message
// button for the Smarty the inbox belongs to ("Message Paul's Smarty").
import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useStepActions, type StepActions } from '@/components/chat/steps/useStepActions';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { actOnInboxItem, inboxItemState, loadInbox, refreshInboxBadge, safeLink, useInboxStore, type InboxAction, type InboxItem, type InboxState } from '@/lib/smartyInbox';

const TABS: { state: InboxState; label: string }[] = [{ state: 'open', label: 'Open' }, { state: 'snoozed', label: 'Snoozed' }, { state: 'resolved', label: 'Resolved' }];
const SNOOZES = [['1h', '1 hour'], ['4h', '4 hours'], ['1d', '1 day'], ['1w', '1 week']] as const;

export function InboxView({ onClose, compact, ownerName }: { onClose: () => void; compact?: boolean; ownerName?: string }): React.ReactNode {
  const { t } = useI18n();
  const storeOpenCount = useInboxStore(s => s.openCount), revision = useInboxStore(s => s.revision);
  // The Open count is the number of items the Open list itself returned (the same response it shows), never a separate
  // total; until the Open list has answered once, the badge's count stands in.
  const [openListed, setOpenListed] = React.useState<number | null>(null);
  const openCount = openListed ?? storeOpenCount;
  const stepActions = useStepActions();
  const [tab, setTab] = React.useState<InboxState>('open');
  const [items, setItems] = React.useState<InboxItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Only the latest request for the tab shown applies (#365 review: a late Open answer must not fill Resolved). reload
  // reads the tab at call time: an action or Undo that finishes after a tab change refreshes the tab shown (round 2).
  const request = React.useRef(0), openRequest = React.useRef(0), shownTab = React.useRef(tab);
  const reload = React.useCallback(() => {
    const mine = ++request.current;
    const listedTab = shownTab.current, openMine = listedTab === 'open' ? ++openRequest.current : 0;
    return loadInbox(listedTab).then(r => {
      if (openMine && openMine === openRequest.current) setOpenListed(r.items.length);
      if (mine === request.current) { setItems(r.items); setError(null); }
    },
      e => { if (mine === request.current) setError(e instanceof Error ? e.message : String(e)); });
  }, []);
  React.useEffect(() => { void reload(); }, [reload, tab, revision]);
  // The desktop shows the first item at once, and keeps it: a newer item arriving (SSE) never swaps the item (and a
  // response being typed) away (#365 review).
  React.useEffect(() => { if (!compact && selectedId === null && items?.[0]) setSelectedId(items[0].id); }, [compact, items, selectedId]);
  const listed = items?.find(i => i.id === selectedId) ?? (compact || selectedId !== null ? null : items?.[0] ?? null);
  // A status read can be newer than the tab response. Keep its displayed version until the list catches up.
  const selected = listed?.source?.startsWith('steps:') ? useInboxStore.getState().items.find(i =>
    i.id === listed.id && i.to === listed.to && Date.parse(i.updated) >= Date.parse(listed.updated)) ?? listed : listed;

  const list = (
    <div className={cn('flex min-h-0 flex-col', !compact && 'w-[390px] shrink-0 border-r border-border')}>
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <span aria-hidden className="typography-ui-header">⚑</span>
        <h1 className="typography-ui-header font-semibold">Inbox</h1>
        <Button variant="ghost" size="icon" className="ml-auto size-8" aria-label="Close inbox" onClick={onClose}><Icon name="close" className="size-4" /></Button>
      </div>
      <div role="tablist" className="flex gap-4 border-b border-border px-4">
        {TABS.map(entry => (
          <button key={entry.state} type="button" role="tab" aria-selected={tab === entry.state} onClick={() => { if (entry.state === tab) return; shownTab.current = entry.state; setTab(entry.state); setSelectedId(null); setItems(null); }}
            className={cn('rounded-md px-2 py-1 typography-ui-label', tab === entry.state ? 'bg-interactive-hover text-foreground' : 'text-muted-foreground')}>
            {entry.label}{entry.state === 'open' ? ` ${openCount}` : ''}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="px-4 py-3 typography-ui-label text-destructive">{error}</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={`${tab} inbox items`}>
        {items?.length === 0 ? <li className="px-4 py-6 typography-ui-label text-muted-foreground">Nothing here.</li> : null}
        {items?.map(item => (
          <li key={item.id}>
            <button type="button" data-inbox-item={item.id} onClick={() => setSelectedId(item.id)} aria-current={selected?.id === item.id}
              className={cn('block w-full border-b border-border px-4 py-3 text-left hover:bg-interactive-hover', selected?.id === item.id && 'bg-interactive-hover')}>
              {/* smarty-code#1407: a card is the title, the why and the recommendation. No priority badge (the order
                  keeps P0 first) and never item.source, which holds the agent's internal notes. */}
              <span className="line-clamp-2 typography-ui-label text-foreground">{item.title}</span>
              {item.why ? <span className="mt-0.5 line-clamp-3 typography-micro text-muted-foreground">{item.why}</span> : null}
              {item.recommendation ? <span className="mt-0.5 line-clamp-2 typography-micro text-foreground">{t('inbox.card.recommended', { text: item.recommendation })}</span> : null}
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
      {selected ? <InboxItemDetail key={selected.id} item={selected} compact={compact} onBack={() => setSelectedId(null)} onChanged={reload} stepActions={stepActions} ownerName={ownerName} /> : null}
    </div>
  );
}

function InboxItemDetail({ item, compact, onBack, onChanged, stepActions, ownerName }: { item: InboxItem; compact?: boolean; onBack: () => void; onChanged: () => Promise<void>; stepActions: StepActions; ownerName?: string }) {
  const { t } = useI18n();
  const guardedReopen = useInboxStore(s => s.guardedReopen);
  const steps = Boolean(item.source?.startsWith('steps:'));
  const canReopen = !steps || guardedReopen;
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState<null | 'respond' | 'edit'>(null), [text, setText] = React.useState('');
  const status = steps ? stepActions.status(item) : undefined;
  const locked = busy || status?.state === 'pending' || status?.state === 'uncertain';
  const allowed = (action: string) => item.actions.includes(action);
  const writeDisplayed = async (target: InboxItem, action: InboxAction, body: Record<string, string>) => {
    if (target.source?.startsWith('steps:') && (action === 'answer' || action === 'reopen')) {
      if (action === 'reopen' && !useInboxStore.getState().guardedReopen) throw new Error(t('steps.undoUnavailable'));
      const result = await stepActions.act(target, action, body);
      if (result?.state === 'refused') throw new Error(result.error || t('common.unavailable'));
      return result?.state === 'stored' ? result.item : null;
    }
    return actOnInboxItem(target.id, action, body);
  };
  const act = async (action: InboxAction, body: Record<string, string>, done?: string) => {
    if (locked) return;
    setBusy(true); setError(null);
    const scope = captureRuntimeRequestScope();
    try {
      const stored = await writeDisplayed(item, action, body);
      if (!stored || !isRuntimeRequestScopeCurrent(scope)) return;
      if (steps) {
        if (stored.id !== item.id || stored.to !== item.to) throw new Error(t('common.unavailable'));
        useInboxStore.getState().recordItem(stored, scope);
      }
      if (action === 'answer') { setReply(null); setText(''); }
      if (done) toast.success(done, { duration: 5000, action: canReopen ? { label: 'Undo', onClick: () => {
        if (!isRuntimeRequestScopeCurrent(scope)) return;
        void Promise.resolve().then(() => writeDisplayed(steps ? stored : item, 'reopen', {})).then(reopened => {
          if (!reopened || !isRuntimeRequestScopeCurrent(scope)) return;
          if (steps) {
            if (reopened.id !== item.id || reopened.to !== item.to) throw new Error(t('common.unavailable'));
            useInboxStore.getState().recordItem(reopened, scope);
          }
          return onChanged().then(() => { if (!steps && isRuntimeRequestScopeCurrent(scope)) return refreshInboxBadge(); });
        }).catch(e => { if (isRuntimeRequestScopeCurrent(scope)) toast.error(e instanceof Error ? e.message : t('common.unavailable')); });
      } } : undefined });
      await onChanged();
      if (!steps || (action !== 'answer' && action !== 'reopen')) void refreshInboxBadge();
    } catch (e) { if (isRuntimeRequestScopeCurrent(scope)) setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const state = inboxItemState(item);
  const details = item.links.map(link => safeLink(link.url)).find(Boolean);
  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={item.title}>
      <div className={cn('min-h-0 flex-1 overflow-y-auto py-5', compact ? 'px-4' : 'px-7')}>
        {compact ? <Button variant="ghost" size="sm" className="mb-2 -ml-2" onClick={onBack}><Icon name="arrow-left" className="size-4" />Inbox</Button> : null}
        <h2 className="break-words typography-ui-header font-semibold text-foreground">{item.title}</h2>
        {item.why ? <><h3 className="mt-4 typography-micro font-semibold uppercase text-muted-foreground">Why</h3><p className="mt-1 whitespace-pre-wrap typography-ui-label">{item.why}</p></> : null}
        {item.recommendation ? (
          <div className="mt-4 rounded-md border border-[var(--status-success-border,theme(colors.green.300))] bg-[var(--status-success-background,theme(colors.green.50))] p-3">
            <h3 className="typography-micro font-semibold uppercase text-[var(--status-success,theme(colors.green.700))]">Recommendation</h3>
            <p className="mt-1 whitespace-pre-wrap typography-ui-label">{item.recommendation}</p>
          </div>) : null}
        {details ? <p className="mt-4 typography-ui-label"><a href={details} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t('inbox.card.details')}</a></p> : null}
        {item.answer ? <p className="mt-4 typography-micro text-muted-foreground">Answered ({item.answer.action ?? 'respond'}){item.answer.text ? `: ${item.answer.text}` : ''}</p> : null}
        {reply ? (
          <div className="mt-4">
            <Textarea aria-label={reply === 'edit' ? 'Your edit' : 'Your response'} value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus />
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={locked || !text.trim()} onClick={() => void act('answer', { text, action: reply })}>Send</Button>
              <Button size="sm" variant="ghost" onClick={() => setReply(null)}>Cancel</Button>
            </div>
          </div>) : null}
        {steps && !guardedReopen ? <p className="mt-3 typography-micro text-muted-foreground">{t('steps.undoUnavailable')}</p> : null}
        {status?.state === 'uncertain' ? <div className="mt-3">
          <p role="alert" className="typography-ui-label text-muted-foreground">{t('steps.uncertain')}</p>
          <Button size="sm" variant="outline" onClick={() => void stepActions.check(item)}>{t('steps.checkStatus')}</Button>
        </div> : null}
        {error ? <p role="alert" className="mt-3 typography-ui-label text-destructive">{error}</p> : null}
      </div>
      <div className={cn('flex flex-wrap gap-2 py-3', compact ? 'px-4' : 'px-7', compact && 'border-t border-border pb-[max(0.75rem,env(safe-area-inset-bottom))]')}>
        {state === 'resolved' ? canReopen && <Button size="sm" variant="outline" disabled={locked} onClick={() => void act('reopen', {})}>Reopen</Button> : <>
          {allowed('accept') ? <Button size="sm" disabled={locked} onClick={() => void act('resolve', { action: 'accept' }, 'Accepted')}>✓ Accept</Button> : null}
          {allowed('respond') ? <Button size="sm" variant="outline" disabled={locked} onClick={() => setReply('respond')}>{ownerName ? t('inbox.card.messageOwner', { name: ownerName }) : '✎ Respond'}</Button> : null}
          {allowed('edit') ? <Button size="sm" variant="outline" disabled={locked} onClick={() => setReply('edit')}>Edit</Button> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={locked}>Snooze ▾</Button></DropdownMenuTrigger>
            <DropdownMenuContent>{SNOOZES.map(([value, label]) => <DropdownMenuItem key={value} onSelect={() => void act('snooze', { for: value }, `Snoozed for ${label}`)}>{label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
          {allowed('ignore') ? <Button size="sm" variant="ghost" disabled={locked} onClick={() => void act('resolve', { action: 'ignore' }, 'Ignored')}>Ignore</Button> : null}
        </>}
      </div>
    </article>
  );
}
