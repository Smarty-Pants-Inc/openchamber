// smarty-code#1407: the org agent session's history, through the same sync store and message loader the chat view
// uses (ChatContainer: useSync().ensureSessionRenderable + useSessionMessageRecords). Live updates arrive through that
// store's existing event stream; this adds no transport, request or poller of its own.
import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { OrgAgent } from '@/lib/smartyOrgAgent';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus, useSessionMessageLoadState, useSessionMessageRecords, useSessionRenderable } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useViewOnlyWatch } from '@/sync/view-only-watch';
import { TimelineDialog } from '@/components/chat/TimelineDialog';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { feedEntries } from './feedEntries';
import { FeedNotice, FeedTranscript } from './FeedTranscript';
import { scrollFeedByTurn, scrollToFeedEntry } from './feedScroll';

type SessionLocation = { state: 'loading' } | { state: 'missing' } | { state: 'failed' } | { state: 'ready'; directory: string };

/**
 * The session's own directory (the canonical resolver), which every message read is keyed by. An org agent session can
 * live outside the opened projects, so the global session list is the fallback; until it has loaded once, a session it
 * does not know is still loading, and a failed list is a failure, never "missing".
 */
function useSessionLocation(sessionId: string): SessionLocation {
  const globalDirectory = useGlobalSessionsStore(state => {
    const session = state.entityById.get(sessionId);
    return session ? resolveGlobalSessionDirectory(session) : null;
  });
  const hasLoaded = useGlobalSessionsStore(state => state.hasLoaded);
  const listFailed = useGlobalSessionsStore(state => state.status === 'error');
  const resolved = useSessionUIStore(state => state.getDirectoryForSession(sessionId)) ?? globalDirectory;
  React.useEffect(() => { if (!resolved) void ensureGlobalSessionsLoaded().catch(() => undefined); }, [resolved]);
  if (resolved) return { state: 'ready', directory: resolved };
  if (listFailed) return { state: 'failed' };
  return hasLoaded ? { state: 'missing' } : { state: 'loading' };
}

/** `timelineOpen`: the chat's Timeline dialog for this session, opened from the Feed header; it jumps between the person's messages. */
export type FeedConversationProps = { agent: OrgAgent; timelineOpen: boolean; onTimelineOpenChange: (open: boolean) => void };

export function FeedConversation({ agent, timelineOpen, onTimelineOpenChange }: FeedConversationProps): React.ReactNode {
  const { t } = useI18n();
  const location = useSessionLocation(agent.sessionId);
  if (location.state === 'loading') return <FeedNotice>{t('feed.loading')}</FeedNotice>;
  if (location.state === 'missing') return <FeedNotice alert>{t('feed.sessionMissing')}</FeedNotice>;
  if (location.state === 'failed') return <FeedNotice alert>{t('feed.historyFailed')}</FeedNotice>;
  return <FeedHistory sessionId={agent.sessionId} directory={location.directory} name={agent.name} timelineOpen={timelineOpen} onTimelineOpenChange={onTimelineOpenChange} />;
}

function FeedHistory({ sessionId, directory, name, timelineOpen, onTimelineOpenChange }: {
  sessionId: string; directory: string; name: string; timelineOpen: boolean; onTimelineOpenChange: (open: boolean) => void;
}): React.ReactNode {
  const sync = useSync();
  const records = useSessionMessageRecords(sessionId, directory);
  const load = useSessionMessageLoadState(sessionId, directory);
  const renderable = useSessionRenderable(sessionId, directory);
  // Live activity comes from the live status index, never from an unfinished message in history.
  const status = useGlobalSessionStatus(sessionId);
  // A View only session's live tail is held only while a view shows it (smarty-code#455); a no-op otherwise.
  useViewOnlyWatch(sessionId, directory, load.readOnly === true, true);
  // One automatic load per shown session. If its cache is evicted later (a constrained phone cache, while the chat
  // under this page loads another session of the same directory), the page offers Try again rather than reloading
  // on its own: two views re-loading each other's evicted sessions would never stop.
  const loaded = React.useRef<string | null>(null);
  const key = `${directory}\u0000${sessionId}`;
  React.useEffect(() => {
    if (renderable || loaded.current === key) return;
    loaded.current = key;
    void sync.ensureSessionRenderable(sessionId, false, directory);
  }, [directory, key, renderable, sessionId, sync]);
  const entries = React.useMemo(() => feedEntries(records), [records]);
  const settledWithout = !renderable && load.status !== 'loading' && loaded.current === key;
  const scroller = React.useRef<HTMLDivElement | null>(null);
  return (
    <>
      <FeedTranscript entries={entries} name={name} working={status?.type === 'busy' || status?.type === 'retry'}
        loading={!renderable && !settledWithout && load.status !== 'error'} failed={load.status === 'error' || settledWithout}
        onRetry={() => void sync.ensureSessionRenderable(sessionId, true, directory)} scrollerRef={scroller} />
      <TimelineDialog open={timelineOpen} onOpenChange={onTimelineOpenChange} sessionId={sessionId} directory={directory}
        onScrollToMessage={async messageId => scrollToFeedEntry(scroller.current, messageId)}
        onScrollByTurnOffset={offset => scrollFeedByTurn(scroller.current, offset)}
        onResumeToLatest={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }} />
    </>
  );
}
