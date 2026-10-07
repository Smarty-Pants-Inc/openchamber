// smarty-code#1407: a Smarty: one person's continuous conversation with their Smarty (their org instance), read from the
// gateway's feed. The person's own Smarty adds their inbox (to the right on a desktop; on a phone, a sheet the header's
// Inbox button opens) and a message box. Anyone else's Smarty is view only: the transcript, nothing to act with.
// The view paints once, from the first feed response: no spinner before it and no layout jump after it.
import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { InboxView } from '@/components/views/InboxView';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useInboxStore } from '@/lib/smartyInbox';
import { loadSmartyFeed, openSmartyStream, sendSmartyMessage, type Smarty, type SmartyBlock, type SmartyFeed, type SmartyStream } from '@/lib/smarties';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ascendingId } from '@/sync/session-actions';
import { FeedNotice, FeedTranscript, type BlockText } from './FeedTranscript';
import { ensureSmartiesLoaded, readFeedDraft, useFeedDraft, useFeedStore } from './feedStore';

/** What the view reads and writes through; tests replace them, the app uses the gateway. */
export type FeedServices = {
  loadFeed: (id: string, after?: number) => Promise<SmartyFeed>;
  openStream: (id: string, handlers: { onBlocks: (feed: SmartyFeed) => void; onReconnect: () => void }) => SmartyStream;
  send: (id: string, text: string, clientId: string) => Promise<void>;
  /** A block's text (the chat's Markdown renderer). */
  Text?: BlockText;
};
const defaultServices: FeedServices = { loadFeed: (id, after) => loadSmartyFeed(id, after), openStream: openSmartyStream, send: (id, text, clientId) => sendSmartyMessage(id, text, clientId) };

/** `onClose` shows the old view (the phone's way to it; a desktop uses the nav's bottom button). */
export function FeedView({ onClose, compact = false, services }: { onClose: () => void; compact?: boolean; services?: Partial<FeedServices> }): React.ReactNode {
  const { t } = useI18n();
  const smarties = useFeedStore(state => state.smarties);
  const selectedId = useFeedStore(state => state.selectedId);
  React.useEffect(() => { void ensureSmartiesLoaded(); }, []);
  if (smarties.state === 'failed') {
    return <div className="flex h-full flex-col bg-background"><FeedNotice alert action={<Button size="sm" variant="outline" onClick={() => void ensureSmartiesLoaded(undefined, true)}>{t('feed.retry')}</Button>}>{t('feed.smartiesFailed')}</FeedNotice></div>;
  }
  const smarty = smarties.state === 'ready' ? smarties.smarties.find(item => item.id === selectedId) : undefined;
  // Until the list answers there is nothing true to show: an empty page, never a spinner that a blank replaces.
  if (smarties.state !== 'ready' || !smarty) return <div className="h-full bg-background" />;
  return <SmartyPage key={`${getRuntimeKey()}\u0000${smarty.id}`} smarty={smarty} all={smarties.smarties} me={smarties.me} compact={compact} onClose={onClose} services={{ ...defaultServices, ...services }} />;
}

type FeedState = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; blocks: SmartyBlock[]; offset: number };

/** Adds blocks it has not seen (by id); a stream event and a catch-up read can carry the same block. */
const append = (state: FeedState, feed: SmartyFeed): FeedState => {
  if (state.state !== 'ready') return state;
  const seen = new Set(state.blocks.map(block => block.id));
  const fresh = feed.blocks.filter(block => !seen.has(block.id));
  return { state: 'ready', blocks: fresh.length ? [...state.blocks, ...fresh] : state.blocks, offset: Math.max(state.offset, feed.offset) };
};

function useSmartyFeed(id: string, services: FeedServices) {
  const [feed, setFeed] = React.useState<FeedState>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const offset = React.useRef(0);
  React.useEffect(() => { if (feed.state === 'ready') offset.current = feed.offset; }, [feed]);
  React.useEffect(() => {
    let current = true, stream: SmartyStream | null = null;
    services.loadFeed(id).then(first => {
      if (!current) return;
      setFeed({ state: 'ready', blocks: first.blocks, offset: first.offset });
      stream = services.openStream(id, {
        onBlocks: next => { if (current) setFeed(state => append(state, next)); },
        // After a drop, read what was appended meanwhile; a failed catch-up waits for the next event.
        onReconnect: () => { void services.loadFeed(id, offset.current).then(next => { if (current) setFeed(state => append(state, next)); }, () => undefined); },
      });
    }, () => { if (current) setFeed({ state: 'failed' }); });
    return () => { current = false; stream?.close(); };
  }, [id, services, attempt]);
  return { feed, retry: () => { setFeed({ state: 'loading' }); setAttempt(n => n + 1); } };
}

function SmartyPage({ smarty, all, me, compact, onClose, services }: {
  smarty: Smarty; all: readonly Smarty[]; me: string; compact: boolean; onClose: () => void; services: FeedServices;
}): React.ReactNode {
  const { t } = useI18n();
  const stableServices = React.useRef(services).current;
  const { feed, retry } = useSmartyFeed(smarty.id, stableServices);
  const ownInbox = useInboxStore(state => state.available) && smarty.own;
  const openCount = useInboxStore(state => state.openCount);
  const [inboxShown, setInboxShown] = React.useState(!compact);
  const inboxButton = React.useRef<HTMLButtonElement | null>(null);
  const inboxLabel = t('feed.inbox.toggle', { count: openCount });
  // The first paint waits for the first feed answer (a short wait on an empty page), so nothing jumps when it comes.
  if (feed.state === 'loading') return <div className="h-full bg-background" />;

  const inbox = <InboxView compact onClose={() => setInboxShown(false)} ownerLabel={smarty.label} />;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className={cn('flex items-center gap-2 border-b border-border', compact ? 'flex-wrap px-3 py-2' : 'px-4 py-3')}>
        {compact && all.length > 1 ? (
          // A phone has no nav column: the Smarties are a row of their own, above the header's buttons.
          <div role="group" aria-label={t('feed.nav.label')} className="flex min-w-0 basis-full flex-wrap items-center gap-1">
            {all.map(item => (
              <Button key={item.id} size="sm" variant="chip" aria-pressed={item.id === smarty.id} onClick={() => useFeedStore.getState().selectSmarty(item.id)}>
                <span className="truncate">{item.label}</span>
              </Button>))}
          </div>
        ) : <h1 className="truncate typography-ui-header font-semibold text-foreground">{smarty.label}</h1>}
        {smarty.writable ? null : <span className="shrink-0 typography-micro text-muted-foreground">{t('feed.viewOnly')}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {ownInbox ? (
            <Button ref={inboxButton} variant={inboxShown ? 'secondary' : 'outline'} size="sm" aria-expanded={inboxShown}
              aria-haspopup={compact ? 'dialog' : undefined} aria-pressed={compact ? undefined : inboxShown} onClick={() => setInboxShown(shown => !shown)}>
              {inboxLabel}
            </Button>) : null}
          {compact ? (
            <Button variant="ghost" size="sm" onClick={onClose}>{t('feed.classic.show')}</Button>) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {feed.state === 'failed'
            ? <FeedNotice alert action={<Button size="sm" variant="outline" onClick={retry}>{t('feed.retry')}</Button>}>{t('feed.historyFailed')}</FeedNotice>
            : <FeedTranscript blocks={feed.blocks} smartyName={smarty.label} me={me} Text={stableServices.Text} />}
          {smarty.own && smarty.writable ? <FeedMessageBox smarty={smarty} send={stableServices.send} /> : null}
        </section>
        {!compact && ownInbox && inboxShown ? (
          <aside className="w-1/3 min-w-[320px] min-h-0 shrink-0 border-l border-border bg-background">{inbox}</aside>) : null}
      </div>
      {/* On a phone the inbox is a modal sheet: focus stays inside while it is open and returns to the Inbox button. */}
      {compact && ownInbox ? (
        <Dialog open={inboxShown} onOpenChange={setInboxShown}>
          <DialogContent showCloseButton={false} finalFocus={inboxButton} aria-label={inboxLabel}
            className="mt-auto -mb-4 h-[86dvh] max-w-none gap-0 overflow-hidden rounded-b-none border-b-0 p-0">
            {inbox}
          </DialogContent>
        </Dialog>) : null}
    </div>
  );
}

/**
 * The message box: Enter sends, Shift+Enter is a new line. The box clears at Send; a failed send puts the text back
 * (before anything typed since) with a plain line saying so. Sending the same text again reuses its client ID, so the
 * gateway never delivers it twice.
 */
function FeedMessageBox({ smarty, send }: { smarty: Smarty; send: FeedServices['send'] }): React.ReactNode {
  const { t } = useI18n();
  const draft = useFeedDraft(smarty.id);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const lastFailed = React.useRef<{ text: string; clientId: string } | null>(null);
  const setDraft = (text: string) => useFeedStore.getState().setDraft(smarty.id, text);
  const label = t('feed.message.label', { name: smarty.label });

  const submit = () => {
    const text = readFeedDraft(smarty.id);
    if (!text.trim() || sending) return;
    const clientId = lastFailed.current?.text === text ? lastFailed.current.clientId : ascendingId('msg');
    setDraft(''); setSending(true); setFailed(false);
    send(smarty.id, text, clientId).then(() => { lastFailed.current = null; }, () => {
      lastFailed.current = { text, clientId };
      const typed = readFeedDraft(smarty.id);
      setDraft(typed.trim() ? `${text}\n\n${typed}` : text);
      setFailed(true);
    }).finally(() => setSending(false));
  };

  return (
    <form className="shrink-0 border-t border-border px-4 py-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1">
        <div className="flex items-end gap-2">
          <Textarea aria-label={label} placeholder={label} rows={2} value={draft}
            outerClassName="min-w-0 flex-1" onChange={event => { setDraft(event.target.value); if (failed) setFailed(false); }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }} />
          <Button type="submit" disabled={!draft.trim() || sending} aria-label={t('feed.reply.send')}><Icon name="send-plane-2" className="size-4" />{t('feed.reply.send')}</Button>
        </div>
        {failed
          ? <p role="alert" className="typography-micro text-[var(--status-error)]">{t('feed.message.failed')}</p>
          : <p aria-live="polite" className="typography-micro text-muted-foreground">{sending ? t('feed.reply.sending') : t('feed.reply.hint')}</p>}
      </div>
    </form>
  );
}
