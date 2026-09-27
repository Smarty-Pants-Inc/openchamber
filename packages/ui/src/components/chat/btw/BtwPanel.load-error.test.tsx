import { expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

mock.module('../ChatMessage', () => ({ default: () => null })); // Its markdown worker does not load under bun test.
mock.module('../markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
const { BtwMessages } = await import('./BtwPanel');
const { I18nProvider } = await import('@/lib/i18n');

// smarty-code#536: a /btw session whose history failed to load said "Loading" forever; it now says so, with Try again.
// SAFETY: the panel's data with the fields BtwMessages reads while its session is empty.
const data = (loadFailed: boolean) => ({
  messageRecords: [], sessionIsWorking: false, streamingMessageId: null, activeStreamingPhase: null,
  sessionPermissions: [], sessionQuestions: [], isEmpty: true, loadFailed, retry: () => {},
}) as never;
const render = (loadFailed: boolean) => renderToString(<I18nProvider>
  <BtwMessages data={data(loadFailed)} bodyRef={{ current: null }} contentRef={{ current: null }} onBodyScroll={() => {}} />
</I18nProvider>);

test('a /btw panel whose history failed to load shows the error with Try again, not Loading', () => {
  const html = render(true);
  expect(html).toContain('role="alert"');
  expect(html.toLowerCase()).toContain('try again');
});

test('while it loads, it still says Loading', () => {
  expect(render(false)).not.toContain('role="alert"');
});
