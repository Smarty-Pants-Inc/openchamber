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
import { loadSmartyFeed, openSmartyStream, type FeedQuery, sendSmartyMessage, SmartiesRequestError, type Smarty, type SmartyBlock, type SmartyFeed, type SmartyStream } from '@/lib/smarties';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ascendingId } from '@/sync/session-actions';
import { FeedNotice, FeedTranscript, type BlockText } from './FeedTranscript';
import { draftKey, ensureSmartiesLoaded, isOwnerLine, readDraftAt, useFeedStore, type FailedSend, type PendingSend } from './feedStore';
import { dismissInitialLoading } from './initialLoading';

/** What the view reads and writes through; tests replace them, the app uses the gateway. */
export type FeedServices = {
  loadFeed: (id: string, query?: FeedQuery) => Promise<SmartyFeed>;
  openStream: (id: string, handlers: { onBlocks: (feed: SmartyFeed) => void; onReconnect: () => void }) => SmartyStream;
  send: (id: string, text: string, clientId: string) => Promise<void>;
  /** A block's text (the chat's Markdown renderer). */
  Text?: BlockText;
};
const defaultServices: FeedServices = { loadFeed: (id, query) => loadSmartyFeed(id, query), openStream: openSmartyStream, send: (id, text, clientId) => sendSmartyMessage(id, text, clientId) };

/**
 * `onClose`: the host's close request. It is ignored on purpose: the Smarty view leaves only to the old view, through
 * the bottom button (or, on a phone, the header's button), never through a host's automatic close.
 */
export function FeedView({ compact = false, services }: { onClose?: () => void; compact?: boolean; services?: Partial<FeedServices> }): React.ReactNode {
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
  return <SmartyPage key={`${getRuntimeKey()}\u0000${smarty.id}`} smarty={smarty} all={smarties.smarties} me={smarties.me} compact={compact} services={{ ...defaultServices, ...services }} />;
}

/** First paint shows the newest 50 blocks; "Show earlier" adds 100 at a time (smarty-code#1407, for a fast first paint). */
export const FIRST_PAGE = 50, EARLIER_PAGE = 100;

/**
 * `blocks`: every block held, oldest first; the newest `shown` of them render. `start`: the gateway's `earlier` cursor,
 * the `before` for the next older page; undefined at the top of the feed.
 */
type ReadyFeed = { state: 'ready'; blocks: SmartyBlock[]; shown: number; offset: number; start?: number };
const NO_PENDING: readonly PendingSend[] = [];
const NO_BLOCKS: readonly SmartyBlock[] = [];
const sameText = (a: string, b: string) => a.trim() === b.trim();

type FeedState = { state: 'loading' } | { state: 'failed' } | ReadyFeed;
export type EarlierState = 'idle' | 'loading' | 'failed';

const unseen = (held: readonly SmartyBlock[], incoming: readonly SmartyBlock[]) => {
  const seen = new Set(held.map(block => block.id));
  return incoming.filter(block => !seen.has(block.id));
};
/** Adds blocks it has not seen (by id) at the end, shown; a stream event and a catch-up read can carry the same block. */
const append = (state: FeedState, feed: SmartyFeed): FeedState => {
  if (state.state !== 'ready') return state;
  const fresh = unseen(state.blocks, feed.blocks);
  return { ...state, blocks: fresh.length ? [...state.blocks, ...fresh] : state.blocks, shown: state.shown + fresh.length, offset: Math.max(state.offset, feed.offset) };
};

/** Catch-up reads after a missed range retry with backoff (1 s doubling to 30 s) until one succeeds. */
const CATCH_UP_MAX_MS = 30_000;

function useSmartyFeed(id: string, services: FeedServices) {
  const [feed, setFeed] = React.useState<FeedState>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [earlier, setEarlier] = React.useState<EarlierState>('idle');
  const offset = React.useRef(0);
  const live = React.useRef(true);
  React.useEffect(() => { if (feed.state === 'ready') offset.current = feed.offset; }, [feed]);
  React.useEffect(() => {
    let current = true, stream: SmartyStream | null = null;
    live.current = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // While a catch-up is out, live stream events wait: the blocks the catch-up returns are older, so they go in first
    // and the waiting events after them, by the server's byte offset (#558 P2a). Blocks are deduped by id, so an overlap
    // between the two is harmless.
    let catchingUp = 0, waiting: SmartyFeed[] = [];
    const fromStream = (next: SmartyFeed) => {
      if (catchingUp > 0) waiting.push(next); else setFeed(state => append(state, next));
    };
    // Reads everything after `from` (the last offset known before the possible gap). A failure retries from the same
    // offset, never from a later one, and keeps the live events waiting.
    const catchUp = (from: number) => {
      catchingUp += 1;
      const read = (tries: number) => {
        services.loadFeed(id, { after: from }).then(next => {
          if (!current) return;
          catchingUp -= 1;
          const held = catchingUp > 0 ? [] : [...waiting].sort((a, b) => a.offset - b.offset);
          if (catchingUp === 0) waiting = [];
          setFeed(state => held.reduce(append, append(state, next)));
        }, () => {
          if (!current) return;
          const timer = setTimeout(() => { timers.delete(timer); read(tries + 1); }, Math.min(CATCH_UP_MAX_MS, 1000 * 2 ** tries));
          timers.add(timer);
        });
      };
      read(0);
    };
    services.loadFeed(id, { limit: FIRST_PAGE }).then(first => {
      if (!current) return;
      offset.current = first.offset;
      // A server that ignores `limit` sends more: they are held, and "Show earlier" reveals them before asking again.
      setFeed({ state: 'ready', blocks: first.blocks, shown: Math.min(FIRST_PAGE, first.blocks.length), offset: first.offset, start: first.earlier ?? undefined });
      stream = services.openStream(id, {
        onBlocks: next => { if (current) fromStream(next); },
        onReconnect: () => { if (current) catchUp(offset.current); },
      });
      // A block appended between the first read and the stream attaching is in neither: read it now.
      catchUp(first.offset);
    }, () => { if (current) setFeed({ state: 'failed' }); });
    return () => { current = false; live.current = false; stream?.close(); timers.forEach(clearTimeout); };
  }, [id, services, attempt]);

  const showEarlier = () => {
    if (feed.state !== 'ready' || earlier === 'loading') return;
    if (feed.blocks.length > feed.shown) {
      setFeed(state => state.state === 'ready' ? { ...state, shown: Math.min(state.blocks.length, state.shown + EARLIER_PAGE) } : state);
      return;
    }
    if (!feed.start) return;
    setEarlier('loading');
    services.loadFeed(id, { before: feed.start, limit: EARLIER_PAGE }).then(page => {
      if (!live.current) return;
      setFeed(state => {
        if (state.state !== 'ready') return state;
        const older = unseen(state.blocks, page.blocks);
        return { ...state, blocks: [...older, ...state.blocks], shown: state.shown + older.length, start: page.earlier ?? undefined };
      });
      setEarlier('idle');
    }, () => { if (live.current) setEarlier('failed'); });
  };
  const hasEarlier = feed.state === 'ready' && (feed.blocks.length > feed.shown || Boolean(feed.start));
  return { feed, retry: () => { setFeed({ state: 'loading' }); setAttempt(n => n + 1); }, earlier: hasEarlier ? { state: earlier, show: showEarlier } : null };
}

function SmartyPage({ smarty, all, me, compact, services }: {
  smarty: Smarty; all: readonly Smarty[]; me: string; compact: boolean; services: FeedServices;
}): React.ReactNode {
  const { t } = useI18n();
  const stableServices = React.useRef(services).current;
  const { feed, retry, earlier } = useSmartyFeed(smarty.id, stableServices);
  // Spec item 3: the own Smarty always holds the inbox (its list says plainly when nothing needs the person).
  const ownInbox = smarty.own;
  const openCount = useInboxStore(state => state.openCount);
  const [inboxShown, setInboxShown] = React.useState(!compact);
  const inboxButton = React.useRef<HTMLButtonElement | null>(null);
  const inboxLabel = t('feed.inbox.toggle', { count: openCount });
  // A sent message shows at once as the owner's line until the feed's own block for it arrives (same text, not in the
  // feed when it was sent); then the feed's block replaces it.
  const key = draftKey(smarty.id);
  const pending = useFeedStore(state => state.pendingSends[key] ?? NO_PENDING);
  const blocks = feed.state === 'ready' ? feed.blocks : NO_BLOCKS;
  const echoed = React.useMemo(() => pending.filter(item => blocks.some(block => isOwnerLine(block, smarty.id)
    && sameText(block.text, item.text) && !item.known.includes(block.id))).map(item => item.clientId), [blocks, pending, smarty.id]);
  React.useEffect(() => { if (echoed.length) useFeedStore.getState().removePendingSends(key, echoed); }, [echoed, key]);
  const knownOwnerLines = (text: string) => blocks.filter(block => isOwnerLine(block, smarty.id) && sameText(block.text, text)).map(block => block.id);
  // The page is painted from real data: lift the app's loading splash now, not when the old view's bootstrap ends.
  React.useEffect(() => { if (feed.state !== 'loading') dismissInitialLoading(); }, [feed.state]);
  // The first paint waits for the first feed answer (a short wait on an empty page), so nothing jumps when it comes.
  if (feed.state === 'loading') return <div className="h-full bg-background" />;

  // The owner's name as people say it ("Paul"), for the inbox's "Message Paul's Smarty" button.
  const ownerName = smarty.id.charAt(0).toUpperCase() + smarty.id.slice(1);
  const inbox = <InboxView compact onClose={() => setInboxShown(false)} ownerName={ownerName} />;
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
            <Button variant="ghost" size="sm" onClick={() => useFeedStore.getState().showClassic()}>{t('feed.classic.show')}</Button>) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {feed.state === 'failed'
            ? <FeedNotice alert action={<Button size="sm" variant="outline" onClick={retry}>{t('feed.retry')}</Button>}>{t('feed.historyFailed')}</FeedNotice>
            : <FeedTranscript blocks={feed.blocks.slice(feed.blocks.length - feed.shown)} pending={pending.filter(item => !echoed.includes(item.clientId))}
                smartyName={smarty.label} owner={smarty.id} ownerName={ownerName} me={me} Text={stableServices.Text} earlier={earlier} />}
          {smarty.own && smarty.writable ? <FeedMessageBox smarty={smarty} send={stableServices.send} knownOwnerLines={knownOwnerLines} /> : null}
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
 * The message box: Enter sends, Shift+Enter is a new line. The box clears at Send and stays the person's from then on.
 * A failed send waits beside it with a plain line and "Send again", which retries exactly that message under its own
 * client ID, so a send the gateway accepted (but whose answer was lost) is never delivered twice, and later typing
 * never merges into it (openchamber#558 P2).
 * A refusal (the gateway answered with a message, such as a 413 "Message is too long…") was never accepted: its text
 * goes back into the box, if the person has not started another, with the gateway's words under it. A message over
 * 120,000 UTF-8 bytes is not sent at all; it stays in the box with a plain note (smarty-code#1407).
 */
const NO_FAILED: readonly FailedSend[] = [];
const MAX_MESSAGE_BYTES = 120_000;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
type Notice = { kind: 'tooLong' } | { kind: 'refused'; text: string };
/** The gateway dedupes a client ID for 24 h from its first send; past that a resend could deliver it twice. */
const DEDUPE_MS = 24 * 3_600_000;
const tooOld = (message: FailedSend) => Date.now() - message.at >= DEDUPE_MS;

function FeedMessageBox({ smarty, send, knownOwnerLines }: { smarty: Smarty; send: FeedServices['send']; knownOwnerLines: (text: string) => string[] }): React.ReactNode {
  const { t } = useI18n();
  // The draft key (runtime and Smarty) is fixed per send: a late answer touches only this key's failed list.
  const key = draftKey(smarty.id);
  const draft = useFeedStore(state => state.drafts[key] ?? '');
  const failed = useFeedStore(state => state.failedSends[key] ?? NO_FAILED);
  const [sending, setSending] = React.useState(0);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const label = t('feed.message.label', { name: smarty.label });

  const deliver = async (message: FailedSend) => {
    setSending(n => n + 1);
    setNotice(null);
    useFeedStore.getState().addPendingSend(key, { ...message, known: knownOwnerLines(message.text) });
    try {
      await send(smarty.id, message.text, message.clientId);
    } catch (error) {
      const store = useFeedStore.getState();
      store.removePendingSends(key, [message.clientId]);
      const refusal = error instanceof SmartiesRequestError ? error.serverMessage : undefined;
      if (refusal) setNotice({ kind: 'refused', text: refusal });
      if (refusal && !readDraftAt(key)) store.setDraftAt(key, message.text);
      // A refused send was never accepted, so its retry is a new message: a fresh client ID (#567 review).
      else store.addFailedSend(key, refusal ? { ...message, clientId: ascendingId('msg') } : message);
    } finally {
      setSending(n => n - 1);
    }
  };
  const submit = () => {
    const text = readDraftAt(key);
    if (!text.trim()) return;
    if (utf8Bytes(text) > MAX_MESSAGE_BYTES) { setNotice({ kind: 'tooLong' }); return; }
    useFeedStore.getState().setDraftAt(key, '');
    void deliver({ text, clientId: ascendingId('msg'), at: Date.now() });
  };
  // Always the same client ID: the original may have been accepted with its answer lost, and only the ID lets the
  // gateway (which dedupes it for 24 h) drop the repeat.
  const sendAgain = (message: FailedSend) => {
    if (tooOld(message)) return; // Checked again at the click: past the window the next render shows Copy text.
    // The size limit holds on every send path, retries included; the entry stays so its text isn't lost (#567 review).
    if (utf8Bytes(message.text) > MAX_MESSAGE_BYTES) { setNotice({ kind: 'tooLong' }); return; }
    useFeedStore.getState().removeFailedSend(key, message.clientId);
    void deliver(message);
  };
  const copy = (message: FailedSend) => { void navigator.clipboard?.writeText(message.text).catch(() => undefined); };

  return (
    <form className="shrink-0 border-t border-border px-4 py-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1">
        <div className="flex items-end gap-2">
          <Textarea aria-label={label} placeholder={label} rows={2} value={draft}
            outerClassName="min-w-0 flex-1" onChange={event => { setNotice(null); useFeedStore.getState().setDraftAt(key, event.target.value); }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }} />
          <Button type="submit" disabled={!draft.trim()} aria-label={t('feed.reply.send')}><Icon name="send-plane-2" className="size-4" />{t('feed.reply.send')}</Button>
        </div>
        {notice ? <p role="alert" className="typography-micro text-[var(--status-error)]">{notice.kind === 'tooLong' ? t('feed.message.tooLong') : notice.text}</p> : null}
        {failed.map(message => (
          <div key={message.clientId} role="alert" className="flex min-w-0 items-center gap-2 typography-micro text-[var(--status-error)]">
            <span className="shrink-0">{t('feed.message.failed')}</span>
            <q className="min-w-0 truncate text-muted-foreground">{message.text}</q>
            {tooOld(message) ? <>
              <span className="shrink-0 text-muted-foreground">{t('feed.message.mayBeSent')}</span>
              <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={() => copy(message)}>{t('feed.message.copy')}</Button>
            </> : <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={() => sendAgain(message)}>{t('feed.message.retry')}</Button>}
          </div>))}
        <p aria-live="polite" className="typography-micro text-muted-foreground">{sending ? t('feed.reply.sending') : t('feed.reply.hint')}</p>
      </div>
    </form>
  );
}
