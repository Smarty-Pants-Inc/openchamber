import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

// smarty-code#701: the inbox page against a fake gateway /inbox: P0 first, only the actions an item allows, Accept
// resolves at once and its toast's Undo reopens, a 413 keeps the typed response and shows the gateway's message.
const posts: { url: string; body: unknown }[] = [];
const toasts: { message: string; undo?: () => void }[] = [];
let answerStatus = 200;
const base = { to: 'paul', links: [], created: '2026-09-28T10:00:00.000Z', updated: '2026-09-28T10:00:00.000Z', source: 'net-lead' };
const items = [
  { ...base, id: 'ask:1', title: 'Only a response', actions: ['respond'], priority: 'normal', why: 'Because.' },
  { ...base, id: 'p0x', title: 'Codex accounts nearly out', actions: ['accept', 'respond', 'ignore'], priority: 'p0', recommendation: 'Add accounts.',
    links: [{ url: 'https://github.com/Smarty-Pants-Inc/smarty-dev/issues/9' }, { url: 'javascript:alert(1)' }] },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (url: string, init: RequestInit = {}) => {
  if (init.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith('/answer') && answerStatus !== 200) return json({ data: { message: 'Answer text is too long for the inbox (at most 3500 bytes); nothing was sent' } }, answerStatus);
    return json({ person: 'paul', item: items[0] });
  }
  return json({ person: 'paul', items });
} }));
const ui = await import('@/components/ui');
mock.module('@/components/ui', () => ({ ...ui, toast: { ...ui.toast,
  success: (message: string, data?: { action?: { onClick: () => void } }) => { toasts.push({ message, undo: data?.action?.onClick }); },
  error: (message: string) => { toasts.push({ message }); } } }));
const { InboxView } = await import('./InboxView');
const { I18nProvider } = await import('@/lib/i18n');
const View = () => <I18nProvider><InboxView onClose={() => undefined} /></I18nProvider>;

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement, Element: win.Element };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const buttons = (root: { querySelectorAll: (s: string) => Iterable<{ textContent: string | null }> }) => [...root.querySelectorAll('article button')].map(b => b.textContent?.trim());
const click = (el: unknown) => act(async () => { (el as unknown as HTMLElement).click(); });

test('the inbox lists P0 first; an item shows only its actions; Accept resolves at once and Undo reopens', async () => {
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  expect([...host.querySelectorAll('[data-inbox-item]')].map(e => e.getAttribute('data-inbox-item'))).toEqual(['p0x', 'ask:1']);
  // The first (P0) item is shown: all its actions, a safe link as an anchor and an unsafe one as text.
  expect(buttons(host)).toEqual(['✓ Accept', '✎ Respond', 'Snooze ▾', 'Ignore']);
  expect([...host.querySelectorAll('article a')].map(a => a.getAttribute('href'))).toEqual(['https://github.com/Smarty-Pants-Inc/smarty-dev/issues/9']);
  expect(host.textContent).toContain('javascript:alert(1)');

  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Accept'))); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/p0x/resolve', body: { action: 'accept' } });
  expect(toasts.at(-1)?.message).toBe('Accepted');
  await act(async () => { toasts.at(-1)!.undo!(); }); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/p0x/reopen', body: {} });

  await click(host.querySelector('[data-inbox-item="ask:1"]')); await settle();
  expect(buttons(host)).toEqual(['✎ Respond', 'Snooze ▾']);
  await act(async () => root.unmount());
});

test('a response too long for the store keeps the text and shows the gateway message', async () => {
  answerStatus = 413;
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  await click(host.querySelector('[data-inbox-item="ask:1"]')); await settle();
  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Respond')));
  const box = host.querySelector('textarea') as unknown as HTMLTextAreaElement;
  await act(async () => {
    // happy-dom's input event doesn't reach React's change tracking here; the handler is called as React would.
    const props = Object.entries(box).find(([key]) => key.startsWith('__reactProps$'))![1] as { onChange: (e: unknown) => void };
    props.onChange({ target: { value: 'a long answer' } });
  });
  await click([...host.querySelectorAll('article button')].find(b => b.textContent === 'Send')); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/ask%3A1/answer', body: { text: 'a long answer', action: 'respond' } });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('too long');
  expect((host.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe('a long answer');
  await act(async () => root.unmount());
});
