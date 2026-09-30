import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { lastRealMessage } from './message/systemNote';
import { useLatestSessionError } from '@/sync/notification-store';
import { useDirectoryStore, useSessionStatus } from '@/sync/sync-context';
import { usePromptsInFlight } from '@/sync/prompts-in-flight';

interface SessionErrorNoticeProps {
  sessionId: string;
  directory?: string;
}

// How long a user message may sit unanswered on an idle session before the
// notice calls it a reply that never began.
const UNANSWERED_AFTER_MS = 5_000;

type LastMessageState = {
  role: string;
  timestamp: number;
  hasError: boolean;
} | null;

// The last message of a session, with whether it already carries an error of
// its own: an assistant message that OpenCode marked failed renders its error
// inline, so the session-level notice must not repeat it.
const useLastMessageState = (sessionId: string, directory?: string): LastMessageState => {
  const store = useDirectoryStore(directory);
  const cacheRef = React.useRef<LastMessageState>(null);
  const getSnapshot = React.useCallback((): LastMessageState => {
    if (!sessionId) return null;
    const messages = store.getState().message[sessionId];
    // A system note (a voice call started or ended) is no reply and no request: judge the last real message.
    const last = lastRealMessage(messages);
    // SAFETY: store messages are SDK `Message` records; `error` is the optional
    // assistant-message error the SDK types carry, read here only for presence.
    const info = last as { role?: string; time?: { completed?: number; created?: number }; error?: unknown } | null;
    if (!info) {
      cacheRef.current = null;
      return null;
    }
    const next: LastMessageState = {
      role: typeof info.role === 'string' ? info.role : '',
      // An optimistic user message has `completed: 0` (session-actions): its time is when it was created (#902 review).
      timestamp: info.time?.completed || info.time?.created || 0,
      hasError: Boolean(info.error),
    };
    const cached = cacheRef.current;
    if (cached && cached.role === next.role && cached.timestamp === next.timestamp && cached.hasError === next.hasError) {
      return cached;
    }
    cacheRef.current = next;
    return next;
  }, [sessionId, store]);
  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe(notify);
  }, [sessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Shows what OpenCode reported when it stopped a turn without producing a
 * reply. Rendered under the last message, only while that turn is the latest
 * one: sending again moves the last message past the error and hides it.
 */
export const SessionErrorNotice: React.FC<SessionErrorNoticeProps> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const latestError = useLatestSessionError(sessionId);
  const status = useSessionStatus(sessionId, directory);
  const lastMessage = useLastMessageState(sessionId, directory);

  const isIdle = !status || status.type === 'idle';
  const reportedError = latestError && isIdle
    && (!lastMessage || latestError.time >= lastMessage.timestamp)
    && !(lastMessage?.role === 'assistant' && lastMessage.hasError)
    ? latestError
    : null;
  // A user message that the session is idle on, with nothing after it for a
  // while, is a reply that never began: the send was accepted but OpenCode
  // produced neither a message nor an error for it.
  // While this page's prompt call is pending, the owner has not answered yet: "Sending…", never "did not start". The
  // clock starts when the call answers (a busy owner under load takes 15-18 s, smarty-code#902). A refusal is an answer
  // with an error, shown by the send's own error path at once.
  const sending = usePromptsInFlight((state) => (state.pending[sessionId] ?? 0) > 0);
  const answeredAt = usePromptsInFlight((state) => state.answeredAt[sessionId] ?? 0);
  const waitingSince = !reportedError && isIdle && lastMessage?.role === 'user' ? Math.max(lastMessage.timestamp, answeredAt) : null;
  // One clock: while sending, from the message (after the same wait it says "Sending…"); after, from the answer.
  const clockSince = waitingSince === null ? null : sending ? lastMessage?.timestamp ?? waitingSince : waitingSince;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (clockSince === null) return undefined;
    const remaining = UNANSWERED_AFTER_MS - (Date.now() - clockSince);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [clockSince, sending]);
  const waited = clockSince !== null && Math.max(now, Date.now()) - clockSince >= UNANSWERED_AFTER_MS;
  // The gateway took it (its receipt, accepted or queued): never "did not start".
  const receipt = usePromptsInFlight((state) => state.receipt[sessionId]);
  const taken = !sending && waitingSince !== null && answeredAt >= (lastMessage?.timestamp ?? 0) && receipt !== undefined;
  const unanswered = !sending && !taken && waited;

  // Taken, whatever the receipt: a Dev1 run answered 'queued' for an idle Pi that then ran it, while the page's live view
  // lagged. So the note says only what is known: the session has it, and its reply shows when the session reports it.
  const waitingNote = sending ? 'chat.sessionError.sending' : taken ? 'chat.sessionError.taken' : null;
  if (waitingNote && waited) {
    return (
      <div className="chat-message-column">
        <div role="status" className="mt-3 text-sm text-muted-foreground">{t(waitingNote)}</div>
      </div>
    );
  }
  if (!reportedError && !unanswered) return null;

  const detail = reportedError
    ? (reportedError.error?.message ?? t('chat.sessionError.noDetails'))
    : t('chat.sessionError.noDetails');
  const name = reportedError?.error?.name;
  const title = reportedError?.sendOutcome === 'refused'
    ? 'chat.send.notSent'
    : reportedError?.sendOutcome === 'unconfirmed'
      ? 'chat.send.unconfirmedTitle'
      : reportedError ? 'chat.sessionError.title' : 'chat.sessionError.noReply';

  return (
    <div className="chat-message-column">
      <div
        role="status"
        className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3 text-base leading-relaxed"
      >
        <div className="flex items-start gap-3">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-medium text-foreground">{t(title)}</div>
            <div className="mt-1 text-foreground/80">{name ? `${name}: ${detail}` : detail}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
