import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Part } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import MessageList, { type MessageListHandle } from '@/components/chat/MessageList';
import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import { useChatTimelineScroll, type TimelineListHandle } from '@/hooks/useChatTimelineScroll';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { createWebAPIs } from '../../packages/web/src/api';
import '@/index.css';

declare const __CHAT_SCROLL_STYLE__: React.CSSProperties;
declare global {
  interface Window {
    scrollFixture: { start: () => void; remount: (withGap?: boolean) => void; beginning: () => void; latest: () => void;
      tick: number; done: boolean; userOwnsScroll: boolean; messageCount: number; gapReads: number; measuredTailSize: () => number | undefined; setAutoFollow: (enabled: boolean) => void; setWorking: (enabled: boolean) => void };
  }
}
const sessionID = 'scroll-proof';
const now = 1700000000000;
const textPart = (messageID: string, text: string, id = `${messageID}-text`): Part => ({ id, sessionID, messageID, type: 'text', text });
const user = (id: string, index: number): ChatMessageEntry => ({ info: { id, sessionID, role: 'user',
  time: { created: now + index * 2000 }, agent: 'build', model: { providerID: 'fixture', modelID: 'fixture' } },
  parts: [textPart(id, `History row ${index}. Inspect the busy session and retain the reader's place.`)] });
const assistant = (id: string, parentID: string, index: number, parts: Part[], complete = true): ChatMessageEntry => ({
  info: { id, sessionID, role: 'assistant', parentID, time: { created: now + index * 2000 + 10, completed: complete ? now + index * 2000 + 1000 : undefined },
    providerID: 'fixture', modelID: 'fixture', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts });
const history = Array.from({ length: 180 }, (_, index) => [user(`user-${index}`, index),
  assistant(`answer-${index}`, `user-${index}`, index, [textPart(`answer-${index}`, Array.from({ length: 4 + index % 5 }, (_, line) => `History ${index}, paragraph ${line}. A measured row above the streaming turn.\n\n`).join(''))])]).flat();
const liveUser = user('live-user', 180);
const firstWindow = Array.from({ length: 6 }, (_, index) => [user(`prefix-user-${index}`, index - 1000),
  assistant(`prefix-answer-${index}`, `prefix-user-${index}`, index - 1000, [textPart(`prefix-answer-${index}`, 'The beginning of the session, loaded from its first window.')])]).flat();
function liveParts(tick: number): Part[] {
  const parts: Part[] = [];
  for (let step = 0; step <= Math.floor(tick / 40); step += 1) {
    const count = Math.min(40, tick - step * 40);
    parts.push({ id: `reason-${step}`, sessionID, messageID: 'live-answer', type: 'reasoning',
      text: `Considering the next operation. ${'reason '.repeat(Math.min(count, 12))}`, time: { start: now, end: count >= 12 ? now + 12 : undefined } });
    parts.push(textPart('live-answer', Array.from({ length: count }, (_, token) => `token-${step}-${token}${token % 8 === 7 ? '\n\n' : ' '}`).join(''), `text-${step}`));
    if (count >= 12) parts.push({ id: `tool-${step}`, sessionID, messageID: 'live-answer', type: 'tool', callID: `call-${step}`, tool: 'bash',
      state: count < 24 ? { status: 'running', input: { command: `printf fixture-${step}` }, title: `Fixture operation ${step}`, time: { start: now }, metadata: { output: 'running\n' } }
        : { status: 'completed', input: { command: `printf fixture-${step}` }, title: `Fixture operation ${step}`, time: { start: now, end: now + 100 }, metadata: {}, output: `Completed fixture operation ${step}.\n${'deterministic output\n'.repeat(5)}` } });
  }
  return parts;
}
useUIStore.setState({ streamingAutoFollowEnabled: true, stickyUserHeader: false });
export function Fixture() {
  const [tick, setTick] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [working, setWorking] = React.useState(true);
  const [epoch, setEpoch] = React.useState<string | undefined>();
  const [prefixRecords, setPrefixRecords] = React.useState(0);
  const [firstWindowLoaded, setFirstWindowLoaded] = React.useState(false);
  const gapReads = React.useRef(0);
  const tailMessages = React.useMemo(() => [...history, liveUser, assistant('live-answer', 'live-user', 180, liveParts(tick), false)], [tick]);
  const messages = React.useMemo(() => firstWindowLoaded ? [...firstWindow, ...tailMessages] : tailMessages, [firstWindowLoaded, tailMessages]);
  const scroll = useChatTimelineScroll({ currentSessionId: sessionID, currentSessionKey: sessionID,
    sessionMessageCount: messages.length, composerOverlayHeight: 0, lastUserMessageId: 'live-user', sessionIsWorking: working });
  const listRef = React.useRef<MessageListHandle | null>(null);
  const legendRef = React.useRef<TimelineListHandle | null>(null);
  const registerScrollList = scroll.registerList;
  const registerList = React.useCallback((list: TimelineListHandle | null) => { legendRef.current = list; registerScrollList(list); }, [registerScrollList]);
  React.useEffect(() => {
    window.scrollFixture = { start: () => setRunning(true), remount: (withGap = false) => { if (withGap) setPrefixRecords(22000); setEpoch(previous => previous ? `${previous}-next` : 'positions'); },
      beginning: () => {
        scroll.onManualNavigation();
        // Match ChatContainer's Beginning: load position zero, commit, then
        // navigate. Navigating into an unloaded gap first is a different path.
        if (prefixRecords && !firstWindowLoaded) {
          gapReads.current += 1;
          // The real loader publishes its external-store update before its
          // load promise resolves. Commit the fixture's local state likewise.
          flushSync(() => setFirstWindowLoaded(true));
          requestAnimationFrame(() => listRef.current?.scrollToStart());
        } else listRef.current?.scrollToStart();
      }, latest: () => scroll.goToBottom('instant'),
      tick, done: tick >= 240, userOwnsScroll: scroll.userOwnsScroll, messageCount: messages.length, gapReads: gapReads.current, measuredTailSize: () => { const state = legendRef.current?.getState(); return state?.sizeAtIndex(state.data.length - 1); }, setAutoFollow: enabled => useUIStore.setState({ streamingAutoFollowEnabled: enabled }), setWorking };
  }, [firstWindowLoaded, messages.length, prefixRecords, scroll, tick]);
  React.useEffect(() => {
    if (!running || tick >= 240) return;
    const timer = setTimeout(() => setTick(previous => previous + 1), 20);
    return () => clearTimeout(timer);
  }, [running, tick]);
  // The pre-fix list uses this gesture release prop. Keep it in baseline
  // replays; the fixed list ignores it because native end maintenance is off.
  const legacyEndRelease = { endPinningReleased: scroll.userOwnsScroll };
  return <main className="fixed inset-0 bg-background text-foreground">
    <MessageList {...legacyEndRelease} ref={listRef} sessionKey={sessionID} messages={messages} isLoadingOlder={false} sessionIsWorking={working}
      activeStreamingMessageId={working ? 'live-answer' : null} activeStreamingPhase={working ? 'streaming' : undefined}
      positions={epoch ? { total: prefixRecords + tailMessages.length,
        ranges: [...(firstWindowLoaded ? [{ start: 0, end: firstWindow.length }] : []), { start: prefixRecords, end: prefixRecords + tailMessages.length }], epoch } : undefined}
      positionOf={id => { const prefix = firstWindow.findIndex(message => message.info.id === id); return prefix >= 0 ? prefix : prefixRecords + tailMessages.findIndex(message => message.info.id === id); }}
      onLoadWindow={windows => { gapReads.current += windows.length; if (windows.some(window => window.start === 0)) setFirstWindowLoaded(true); }}
      registerList={registerList}
      anchorMessageId={scroll.anchorMessageId} onAnchorReady={scroll.onAnchorReady} onAnchorSizeChanged={scroll.onAnchorSizeChanged}
      onIsAtEndChange={scroll.onIsAtEndChange} onTimelineDataChange={scroll.onTimelineDataChange}
      scrollContainerProps={{ className: 'absolute inset-0 overflow-y-auto overflow-x-hidden chat-scroll', style: __CHAT_SCROLL_STYLE__, 'data-scrollbar': 'chat', tabIndex: 0 }} />
  </main>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root missing');
createRoot(root).render(<RuntimeAPIProvider apis={createWebAPIs()}><ThemeSystemProvider><I18nProvider><SyncProvider sdk={createOpencodeClient({ baseUrl: window.location.origin })} directory=""><Fixture /></SyncProvider></I18nProvider></ThemeSystemProvider></RuntimeAPIProvider>);
