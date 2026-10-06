import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { viewOnlyWatchVisible } from './view-only-watch';

// openchamber#278 review: a hidden session view releases its watch. messagesEnabled is a history flag, not visibility:
// an embedded tab keeps it true while its visibility handshake says hidden (App.tsx, #2903).
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('only a shown, subscribed, uncovered view is visible for its watch', () => {
  expect(viewOnlyWatchVisible({ active: true, messagesEnabled: true, covered: false })).toBe(true); // Shown.
  expect(viewOnlyWatchVisible({ active: false, messagesEnabled: true, covered: false })).toBe(false); // A background tab.
  expect(viewOnlyWatchVisible({ active: false, messagesEnabled: false, covered: false })).toBe(false); // Another panel.
  expect(viewOnlyWatchVisible({ active: true, messagesEnabled: true, covered: true })).toBe(false); // A phone's full-screen Plan.
});

test('the shells feed their real visibility into the watch', () => {
  const chat = source('../components/views/ChatView.tsx');
  expect(chat).toContain('viewOnlyWatchVisible({ active, messagesEnabled: messagesEnabled ?? active, covered: covered === true })');
  const app = source('../App.tsx'); // The embedded tab: history always on, visibility from its handshake.
  expect(/<ChatView\s+active=\{embeddedBackgroundWorkEnabled\}[\s\S]*?messagesEnabled=\{true\}/.test(app)).toBe(true);
  const mobile = source('../apps/MobileApp.tsx'); // A phone's full-screen surfaces, the Plan included.
  // smarty-code#701 and #1407: the inbox and the Feed are full-screen surfaces too; they cover the chat like the others.
  expect(mobile).toContain("covered={mobileChatCovered(feedOpen ? 'feed' : inboxOpen ? 'inbox' : activeSurface, surfaceVariant, showCapacitorOnlyFeatures, openPlan !== null)}");
});

test('every renderer of the shared transcript holds its watch (review 12): ChatView, the agent group detail, Mini Chat', () => {
  // Mini Chat's hold is also exercised through its real render (ElectronMiniChatApp.viewonly.test.tsx).
  expect(source('../components/views/ChatView.tsx')).toContain('useShownViewOnlyWatch(viewOnlyWatchVisible(');
  expect(source('../components/views/agent-manager/AgentGroupDetail.tsx')).toContain('useShownViewOnlyWatch(selectedSession !== null && isSessionSynced)');
  expect(source('../apps/ElectronMiniChatApp.tsx')).toContain('useShownViewOnlyWatch(!sessionUnavailable)');
  // These three are the transcript's renderers today (each renders ChatContainer).
  const renderers = ['../components/views/ChatView.tsx', '../components/views/agent-manager/AgentGroupDetail.tsx', '../components/mini-chat/MiniChatLayout.tsx'];
  for (const path of renderers) expect(source(path)).toContain('<ChatContainer');
});
