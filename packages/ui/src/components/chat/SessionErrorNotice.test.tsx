import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { useNotificationStore } from '@/sync/notification-store';
import { SessionErrorNotice } from './SessionErrorNotice';

// smarty-code#1108: a send the server refused before taking it is titled "not sent"; a reply the session stopped keeps
// "stopped this reply". The body is the server's own words in both.
const render = async (sessionId: string) => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <SyncProvider directory="/fixture" sdk={createOpencodeClient({ baseUrl: 'http://opencode.test', fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }) })}>
        <I18nProvider><SessionErrorNotice sessionId={sessionId} directory="/fixture" /></I18nProvider>
      </SyncProvider>));
    return container.textContent ?? '';
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
};

const BLOCKED = "The session's terminal is busy (a dialog, typed text or another message is waiting there). Nothing was sent; finish in the terminal, then send it again.";

test('a refused send is titled "not sent", never "stopped this reply"', async () => {
  useNotificationStore.getState().append({ type: 'error', session: 's-refused', directory: '/fixture', time: Date.now(), viewed: true,
    refused: true, error: { name: null, message: BLOCKED } });
  const text = await render('s-refused');
  expect(text).toContain('This message was not sent');
  expect(text).not.toContain('stopped this reply');
  expect(text).toContain(BLOCKED);
});

test('a reply the session stopped keeps "stopped this reply"', async () => {
  useNotificationStore.getState().append({ type: 'error', session: 's-stopped', directory: '/fixture', time: Date.now(), viewed: true,
    error: { name: 'APIError', message: 'Pi disconnected; operation outcome may be unknown.' } });
  const text = await render('s-stopped');
  expect(text).toContain('stopped this reply');
  expect(text).not.toContain('This message was not sent');
});
