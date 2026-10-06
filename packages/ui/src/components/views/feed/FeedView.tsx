// smarty-code#1407: the Feed, Kate's "org feed": only the person's conversation with their Smarty (their org agent),
// their inbox beside it, and a reply box. A bandaid until the Smarty app lands, so the layout stays plain: one readable
// column for the conversation, the inbox to its right on a desktop and, on a phone, in a modal sheet the header's
// Inbox button opens. The header's Timeline button opens the chat's Timeline to jump between the person's messages.
import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { InboxView } from '@/components/views/InboxView';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useInboxStore } from '@/lib/smartyInbox';
import { loadOrgAgent, type OrgAgent, type OrgAgentResult } from '@/lib/smartyOrgAgent';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { SendRecovery, isClientIdConflict, type RecoveryNotice } from '@/lib/sendRecovery';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { usePromptsInFlight } from '@/sync/prompts-in-flight';
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification';
import { ascendingId } from '@/sync/session-actions';
import { FeedConversation, type FeedConversationProps } from './FeedConversation';
import { FeedNotice } from './FeedTranscript';
import { FeedSendUnavailableError, sendFeedReply, type FeedReply } from './feedSend';
import { readFeedDraft, useFeedDraft, useFeedStore } from './feedStore';

export type { FeedReply } from './feedSend';
/** What the page reads and writes through; tests replace them, the app uses the defaults. */
export type FeedServices = {
  loadOrgAgent: () => Promise<OrgAgentResult>;
  send: (reply: FeedReply) => Promise<void>;
  Conversation: React.ComponentType<FeedConversationProps>;
};
const defaultServices: FeedServices = { loadOrgAgent: () => loadOrgAgent(), send: sendFeedReply, Conversation: FeedConversation };

type AgentState = { state: 'loading' } | { state: 'failed' } | OrgAgentResult;

export function FeedView({ onClose, compact = false, services }: { onClose: () => void; compact?: boolean; services?: Partial<FeedServices> }): React.ReactNode {
  const { t } = useI18n();
  const { loadOrgAgent: load, send, Conversation } = { ...defaultServices, ...services };
  const [agent, setAgent] = React.useState<AgentState>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const scope = captureRuntimeRequestScope();
    let current = true;
    setAgent({ state: 'loading' });
    load().then(result => { if (current && isRuntimeRequestScopeCurrent(scope)) setAgent(result); },
      () => { if (current && isRuntimeRequestScopeCurrent(scope)) setAgent({ state: 'failed' }); });
    return () => { current = false; };
  }, [load, attempt]);

  const inboxAvailable = useInboxStore(state => state.available);
  const openCount = useInboxStore(state => state.openCount);
  const [inboxShown, setInboxShown] = React.useState(!compact);
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const inboxButton = React.useRef<HTMLButtonElement | null>(null);
  const inboxLabel = t('feed.inbox.toggle', { count: openCount });

  const ready = agent.state === 'ready' ? agent.agent : null;
  let body: React.ReactNode;
  if (ready) body = <><Conversation agent={ready} timelineOpen={timelineOpen} onTimelineOpenChange={setTimelineOpen} /><FeedReplyBox agent={ready} send={send} /></>;
  else if (agent.state === 'none') body = <FeedNotice>{t('feed.noOrgAgent')}</FeedNotice>;
  else if (agent.state === 'failed') body = <FeedNotice alert action={<Button size="sm" variant="outline" onClick={() => setAttempt(n => n + 1)}>{t('feed.retry')}</Button>}>{t('feed.loadFailed')}</FeedNotice>;
  else body = <FeedNotice>{t('feed.loading')}</FeedNotice>;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className={cn('flex items-center gap-2 border-b border-border', compact ? 'px-3 py-2' : 'px-4 py-3')}>
        <Icon name="chat-ai-3" className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate typography-ui-header font-semibold text-foreground">{ready?.name ?? t('feed.nav.label')}</h1>
        {ready ? (
          <span className="flex shrink-0 items-center gap-1.5 typography-micro text-muted-foreground">
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', ready.live ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/50')} />
            {ready.live ? t('feed.status.live') : t('feed.status.offline')}
          </span>) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {ready ? (
            <Button variant="ghost" size="icon" className="size-8" aria-label={t('chat.timeline.title')} title={t('chat.timeline.title')}
              aria-haspopup="dialog" onClick={() => setTimelineOpen(true)}><Icon name="time" className="size-4" /></Button>) : null}
          {inboxAvailable ? (
            <Button ref={inboxButton} variant={inboxShown ? 'secondary' : 'outline'} size="sm" aria-expanded={inboxShown}
              aria-haspopup={compact ? 'dialog' : undefined} aria-pressed={compact ? undefined : inboxShown} onClick={() => setInboxShown(shown => !shown)}>
              {inboxLabel}
            </Button>) : null}
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('feed.close')} onClick={onClose}><Icon name="close" className="size-4" /></Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</section>
        {!compact && inboxAvailable && inboxShown ? (
          <aside className="w-1/3 min-w-[320px] min-h-0 shrink-0 border-l border-border bg-background">
            <InboxView compact onClose={() => setInboxShown(false)} />
          </aside>) : null}
      </div>
      {/* On a phone the inbox is a modal sheet: focus stays inside while it is open and returns to the Inbox button. */}
      {compact && inboxAvailable ? (
        <Dialog open={inboxShown} onOpenChange={setInboxShown}>
          <DialogContent showCloseButton={false} finalFocus={inboxButton} aria-label={inboxLabel}
            className="mt-auto -mb-4 h-[86dvh] max-w-none gap-0 overflow-hidden rounded-b-none border-b-0 p-0">
            <InboxView compact onClose={() => setInboxShown(false)} />
          </DialogContent>
        </Dialog>) : null}
    </div>
  );
}

/**
 * The plain reply box: Enter sends, Shift+Enter is a new line. It uses the composer's send recovery (lib/sendRecovery):
 * the box clears at Send, a refused or unconfirmed send brings the text back (a re-send keeps its client message ID, so
 * it is never posted twice), and the in-flight prompt state says "Sending…".
 */
function FeedReplyBox({ agent, send }: { agent: OrgAgent; send: FeedServices['send'] }): React.ReactNode {
  const { t } = useI18n();
  const { sessionId, name } = agent;
  const draft = useFeedDraft(sessionId);
  const sending = usePromptsInFlight(state => (state.pending[sessionId] ?? 0) > 0);
  const recovery = React.useRef<SendRecovery | null>(null);
  recovery.current ??= new SendRecovery(() => sendUnconfirmed.ms, () => ascendingId('msg'));
  const setDraft = (text: string) => useFeedStore.getState().setDraft(sessionId, text);
  const notices = {
    unconfirmed: t('chat.send.unconfirmed'), 'delivered-late': t('chat.send.deliveredLate'), 'still-pending': t('chat.send.stillPending'),
  } satisfies Record<RecoveryNotice, string>;

  const submit = () => {
    const text = readFeedDraft(sessionId);
    if (!text.trim() || !recovery.current) return;
    // The draft lives in the store, keyed by this session, so a returned text always has its place (before newer text).
    let restored: { before: string; after: string } | null = null;
    const attempt = recovery.current.begin(`${getRuntimeKey()}\u0000${sessionId}`, SendRecovery.signature(text), {
      restore: () => {
        const before = readFeedDraft(sessionId), after = before.trim() ? `${text}\n\n${before}` : text;
        setDraft(after); restored = { before, after };
        return true;
      },
      clearIfUntouched: () => { if (restored && readFeedDraft(sessionId) === restored.after) setDraft(restored.before); restored = null; },
      notify: kind => toast.info(notices[kind]),
    });
    if (!attempt) return;
    setDraft('');
    send({ sessionId, text, messageID: attempt.messageID }).then(() => attempt.accepted(), (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isClientIdConflict(message)) { if (!attempt.conflict()) toast.info(notices['still-pending']); return; }
      attempt.refused();
      if (error instanceof FeedSendUnavailableError) toast.error(t('feed.reply.noModel'));
      else if (isAmbiguousSendFailure(error)) toast.warning(notices.unconfirmed);
      else toast.error(t('feed.reply.failed', { error: message }));
    });
  };

  return (
    <form className="shrink-0 border-t border-border px-4 py-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1">
        <div className="flex items-end gap-2">
          <Textarea aria-label={t('feed.reply.label', { name })} placeholder={t('feed.reply.placeholder', { name })} rows={2} value={draft}
            outerClassName="min-w-0 flex-1" onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }} />
          <Button type="submit" disabled={!draft.trim()} aria-label={t('feed.reply.send')}><Icon name="send-plane-2" className="size-4" />{t('feed.reply.send')}</Button>
        </div>
        <p aria-live="polite" className="typography-micro text-muted-foreground">{sending ? t('feed.reply.sending') : t('feed.reply.hint')}</p>
      </div>
    </form>
  );
}
