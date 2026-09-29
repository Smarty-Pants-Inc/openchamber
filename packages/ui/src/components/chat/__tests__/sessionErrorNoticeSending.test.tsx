import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { nativeComposerDom } from '../composer/submit/__tests__/nativeComposer-dom';
import { createStore } from 'zustand/vanilla';
import type { Message, UserMessage } from '@opencode-ai/sdk/v2';

// smarty-code#902: on Dev1 under load a busy owner takes 15-18 s to take a prompt. The page said "did not start a reply"
// at +6 s while its own prompt call was still pending. Now: "Sending…" while the call is pending; the 5 s clock starts
// when it answers.
const directoryStore = createStore<{ message: Record<string, Message[]> }>(() => ({ message: {} }));
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => directoryStore, useSessionStatus: () => ({ type: 'idle' }) }));
const { SessionErrorNotice } = await import('../SessionErrorNotice');
const { usePromptsInFlight } = await import('@/sync/prompts-in-flight');
const { I18nProvider } = await import('@/lib/i18n');

const NO_REPLY = 'did not start a reply', SENDING = 'Sending…';
const asked = (created: number) => {
  const info: UserMessage = { id: 'ask', sessionID: 's', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
  directoryStore.setState({ message: { s: [info] } });
};
// A real DOM and root: the store hooks read live state (a server render reads their initial state).
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

test('the prompt call is still pending at +7 s: "Sending…", never "did not start a reply"', () => {
  asked(Date.now() - 7_000);
  usePromptsInFlight.setState({ pending: { s: 1 } });
  const html = notice();
  expect(html).toContain(SENDING);
  expect(html).not.toContain(NO_REPLY);
});

test('pending but still inside the first 5 s: nothing yet (no flicker on a quick send)', () => {
  asked(Date.now() - 1_000);
  usePromptsInFlight.setState({ pending: { s: 1 } });
  expect(notice()).toBe('');
});

test('the owner took it at +18 s: the clock starts at the answer, so no verdict right after it', () => {
  asked(Date.now() - 18_000);
  usePromptsInFlight.setState({ pending: {}, answeredAt: { s: Date.now() - 1_000 } });
  expect(notice()).toBe('');
});

test('the owner answered "queued" at +16 s and the run has not started by +21 s: "Queued…", never "did not start"', () => {
  asked(Date.now() - 21_000);
  usePromptsInFlight.setState({ pending: {}, answeredAt: { s: Date.now() - 6_000 }, receipt: { s: 'queued' } });
  const text = notice();
  expect(text).toContain('Queued:');
  expect(text).not.toContain(NO_REPLY);
});

test('the owner answered "accepted" (a run started) and the status lags: no verdict', () => {
  asked(Date.now() - 21_000);
  usePromptsInFlight.setState({ pending: {}, answeredAt: { s: Date.now() - 6_000 }, receipt: { s: 'accepted' } });
  expect(notice()).toBe('');
});

test('counterexample: answered without a receipt (not taken) and still nothing 5 s later: "did not start a reply" as before', () => {
  asked(Date.now() - 20_000);
  usePromptsInFlight.setState({ pending: {}, answeredAt: { s: Date.now() - 6_000 } });
  expect(notice()).toContain(NO_REPLY);
});

test('counterexample: no call of this page (another tab sent it): the old rule stands', () => {
  asked(Date.now() - 10_000);
  expect(notice()).toContain(NO_REPLY);
});
