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
  const chat = source('../components/chat/ChatContainer.tsx');
  expect(chat).toContain('viewOnlyWatchVisible({ active, messagesEnabled, covered })');
  const app = source('../App.tsx'); // The embedded tab: history always on, visibility from its handshake.
  expect(/<ChatView\s+active=\{embeddedBackgroundWorkEnabled\}[\s\S]*?messagesEnabled=\{true\}/.test(app)).toBe(true);
  const mobile = source('../apps/MobileApp.tsx'); // A phone's full-screen surfaces, the Plan included.
  expect(mobile).toContain('covered={mobileChatCovered(activeSurface, surfaceVariant, showCapacitorOnlyFeatures, openPlan !== null)}');
});
