import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { nativeComposerDom } from '../composer/submit/__tests__/nativeComposer-dom';
import { createStore } from 'zustand/vanilla';
import type { AssistantMessage, Message, UserMessage } from '@opencode-ai/sdk/v2';

// smarty-code#924/#986: a reply this page saw stop (a live session.error: its Pi was killed mid-reply) must still say
// "stopped this reply" after the tab reloads. The native journal may hold only the user entry for a killed reply, so
// after a reload the page had an idle session with a trailing user message and no error: 5 s later it said "did not
// start a reply", which is false. The error this tab observed is kept in its sessionStorage and restored as viewed.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear(), key: () => null, get length() { return memory.size; } } });

const ASKED = Date.now() - 30_000, STOPPED = ASKED + 8_000;
// The previous document of this tab observed the stop live and kept it (the store's own format, written by append).
// A second instance of the store module: `?previous-document` makes Bun load it apart from the one the notice imports.
// @ts-expect-error: the query suffix has no type declaration; it is the same module.
const { appendNotification } = (await import('@/sync/notification-store?previous-document')) as typeof import('@/sync/notification-store');
appendNotification({ type: 'error', session: 's', directory: '/p', time: STOPPED, viewed: false,
  error: { name: 'UnknownError', message: 'The session stopped this reply' } });

// The reloaded document: a fresh store module, and the history the gateway serves (only the user entry).
const directoryStore = createStore<{ message: Record<string, Message[]> }>(() => ({ message: {} }));
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => directoryStore, useSessionStatus: () => ({ type: 'idle' }) }));
const { SessionErrorNotice } = await import('../SessionErrorNotice');
const { useNotificationStore } = await import('@/sync/notification-store');
const { usePromptsInFlight } = await import('@/sync/prompts-in-flight');
const { I18nProvider } = await import('@/lib/i18n');

const NO_REPLY = 'did not start a reply', STOPPED_TITLE = 'stopped this reply';
const user: UserMessage = { id: 'ask', sessionID: 's', role: 'user', time: { created: ASKED }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
const dom = nativeComposerDom();
afterAll(() => dom.restore());
const notice = () => {
  const root = createRoot(dom.container);
  act(() => root.render(<I18nProvider><SessionErrorNotice sessionId="s" /></I18nProvider>));
  const text = dom.container.textContent ?? '';
  act(() => root.unmount());
  return text;
};
beforeEach(() => usePromptsInFlight.setState({ pending: {}, answeredAt: {}, receipt: {} }));

test('after a reload, a reply this tab saw stop still says "stopped this reply", never "did not start a reply"', () => {
  directoryStore.setState({ message: { s: [user] } });
  const restored = useNotificationStore.getState().list;
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ type: 'error', session: 's', time: STOPPED, viewed: true }); // no unseen badge comes back
  const text = notice();
  expect(text).toContain(STOPPED_TITLE);
  expect(text).not.toContain(NO_REPLY);
});

test('counterexample: the reply continued (a newer assistant message after the stop), so no stale "stopped" line', () => {
  const reply: AssistantMessage = { id: 'reply', sessionID: 's', role: 'assistant', parentID: 'ask', time: { created: STOPPED + 1_000, completed: STOPPED + 2_000 },
    modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/p', root: '/p' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as AssistantMessage;
  directoryStore.setState({ message: { s: [user, reply] } });
  expect(notice()).toBe('');
});

test('counterexample: a newer message sent after the stop gets the normal rules (the old stop is not shown for it)', () => {
  const again: UserMessage = { ...user, id: 'again', time: { created: STOPPED + 60_000 } };
  directoryStore.setState({ message: { s: [user, again] } });
  const text = notice();
  expect(text).not.toContain(STOPPED_TITLE);
});

test('a session this tab never saw stop: unchanged, "did not start a reply" after 5 s', () => {
  const other: UserMessage = { ...user, sessionID: 'other' };
  directoryStore.setState({ message: { other: [other] } });
  const root = createRoot(dom.container);
  act(() => root.render(<I18nProvider><SessionErrorNotice sessionId="other" /></I18nProvider>));
  expect(dom.container.textContent ?? '').toContain(NO_REPLY);
  act(() => root.unmount());
});
