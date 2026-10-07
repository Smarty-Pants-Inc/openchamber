import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

// smarty-code#701: the inbox page against a fake gateway /inbox: P0 first, only the actions an item allows, Accept
// resolves at once and its toast's Undo reopens, a 413 keeps the typed response and shows the gateway's message.
const posts: { url: string; body: unknown }[] = [];
const toasts: { message: string; undo?: () => void }[] = [];
let answerStatus = 200;
let postGate: Promise<void> | null = null;
const base = { to: 'paul', links: [], created: '2026-09-28T10:00:00.000Z', updated: '2026-09-28T10:00:00.000Z', source: 'net-lead' };
const items = [
  { ...base, id: 'ask:1', title: 'Only a response', actions: ['respond'], priority: 'normal', why: 'Because.' },
  { ...base, id: 'p0x', title: 'Codex accounts nearly out', actions: ['accept', 'respond', 'ignore'], priority: 'p0', recommendation: 'Add accounts.',
    links: [{ url: 'https://github.com/Smarty-Pants-Inc/smarty-dev/issues/9' }, { url: 'javascript:alert(1)' }] },
];
let listResponder: (url: string) => Promise<Response> | Response = () => json({ person: 'paul', items });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (url: string, init: RequestInit = {}) => {
  if (init.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    if (postGate) await postGate;
    if (url.endsWith('/answer') && answerStatus !== 200) return json({ data: { message: 'Answer text is too long for the inbox (at most 3500 bytes); nothing was sent' } }, answerStatus);
    return json({ person: 'paul', item: items[0] });
  }
  return listResponder(url);
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
  // The first (P0) item is shown: all its actions and one Details link to its first safe link; an unsafe one never shows.
  expect(buttons(host)).toEqual(['✓ Accept', '✎ Respond', 'Snooze ▾', 'Ignore']);
  expect([...host.querySelectorAll('article a')].map(a => [a.textContent, a.getAttribute('href')])).toEqual([['Details', 'https://github.com/Smarty-Pants-Inc/smarty-dev/issues/9']]);
  expect(host.textContent).not.toContain('javascript:alert(1)');

  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Accept'))); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/p0x/resolve', body: { action: 'accept' } });
  expect(toasts.at(-1)?.message).toBe('Accepted');
  await act(async () => { toasts.at(-1)!.undo!(); }); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/p0x/reopen', body: {} });

  await click(host.querySelector('[data-inbox-item="ask:1"]')); await settle();
  expect(buttons(host)).toEqual(['✎ Respond', 'Snooze ▾']);
  await act(async () => root.unmount());
});

// smarty-code#1407 item 6 (R-plain-english, smarty-dev#2264): a card shows only the plain title, the why and the
// recommendation; detail, evidence, link labels and routing metadata never render; evidence sits behind one Details link.
test('a card shows only title, why and recommendation, with evidence behind one Details link', async () => {
  const plain = { ...base, id: 'plain1', title: 'Approve the Codex top-up', actions: ['accept', 'respond'], priority: 'normal',
    why: 'Accounts run out tonight.', recommendation: 'Approve two more accounts.', createdBy: 'code-lead',
    detail: 'RAW DETAIL: stack trace at gateway.ts:12', evidence: 'RAW EVIDENCE: run 4411 log', body: 'RAW BODY text',
    links: [{ url: 'javascript:alert(1)', label: 'BAD LINK' }, { url: 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/1407', label: 'EVIDENCE LABEL' },
      { url: 'https://github.com/Smarty-Pants-Inc/smarty-dev/issues/2264', label: 'SECOND LABEL' }] };
  listResponder = () => json({ person: 'paul', items: [plain] });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  const card = host.querySelector('article')!;
  expect(card.querySelector('h2')?.textContent).toBe('Approve the Codex top-up');
  expect(card.textContent).toContain('Accounts run out tonight.');
  expect(card.textContent).toContain('Approve two more accounts.');
  for (const raw of ['RAW DETAIL', 'RAW EVIDENCE', 'RAW BODY', 'BAD LINK', 'EVIDENCE LABEL', 'SECOND LABEL', 'javascript:', 'net-lead', 'code-lead', 'to paul'])
    expect(card.textContent).not.toContain(raw);
  const links = [...card.querySelectorAll('a')];
  expect(links.map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
    ['Details', 'https://github.com/Smarty-Pants-Inc/smarty-code/issues/1407', '_blank', 'noopener noreferrer']]);
  await act(async () => root.unmount());
  // No safe link: no Details link at all.
  listResponder = () => json({ person: 'paul', items: [{ ...plain, links: [{ url: 'javascript:alert(1)' }] }] });
  const host2 = win.document.createElement('div'); win.document.body.appendChild(host2);
  const root2 = createRoot(host2 as unknown as Element);
  await act(async () => root2.render(<View />)); await settle();
  expect(host2.querySelectorAll('article a').length).toBe(0);
  await act(async () => root2.unmount());
  listResponder = () => json({ person: 'paul', items });
});

test('the message button names the owner\'s Smarty and still opens the response box that answers the item', async () => {
  answerStatus = 200; listResponder = () => json({ person: 'paul', items });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<I18nProvider><InboxView compact ownerName="Paul" onClose={() => undefined} /></I18nProvider>)); await settle();
  await click(host.querySelector('[data-inbox-item="ask:1"]')); await settle();
  expect(buttons(host)).toEqual(['Inbox', 'Message Paul’s Smarty', 'Snooze ▾']);
  await click([...host.querySelectorAll('article button')].find(b => b.textContent === 'Message Paul’s Smarty'));
  const box = host.querySelector('textarea') as unknown as HTMLTextAreaElement;
  await act(async () => { (Object.entries(box).find(([k]) => k.startsWith('__reactProps$'))![1] as { onChange: (e: unknown) => void }).onChange({ target: { value: 'go ahead' } }); });
  await click([...host.querySelectorAll('article button')].find(b => b.textContent === 'Send')); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/ask%3A1/answer', body: { text: 'go ahead', action: 'respond' } });
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

// openchamber#365 review round 1: an incoming item never swaps the shown item (and a response being typed) away; a late
// answer for a tab the person already left never fills the current one.
test('a newer item arriving keeps the shown item and the response being typed', async () => {
  answerStatus = 200; listResponder = () => json({ person: 'paul', items });
  const { useInboxStore } = await import('@/lib/smartyInbox');
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Codex accounts nearly out');
  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Respond')));
  const box = host.querySelector('textarea') as unknown as HTMLTextAreaElement;
  await act(async () => { (Object.entries(box).find(([k]) => k.startsWith('__reactProps$'))![1] as { onChange: (e: unknown) => void }).onChange({ target: { value: 'half written' } }); });
  const newer = { ...base, id: 'p0new', title: 'A newer P0', actions: ['accept'], priority: 'p0', created: '2026-09-29T10:00:00.000Z' };
  listResponder = () => json({ person: 'paul', items: [newer, ...items] });
  await act(async () => { useInboxStore.getState().setOpenItems(true, [newer as never]); }); await settle(); // An SSE refresh.
  expect([...host.querySelectorAll('[data-inbox-item]')].map(e => e.getAttribute('data-inbox-item'))[0]).toBe('p0new');
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Codex accounts nearly out');
  expect((host.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe('half written');
  await act(async () => root.unmount());
});

test('a late answer for the tab the person left never fills the tab they are on', async () => {
  let releaseOpen!: () => void;
  const resolvedItem = { ...base, id: 'done1', title: 'Already resolved', actions: ['accept'], priority: 'normal', resolved: { at: '2026-09-28T11:00:00.000Z', by: 'paul' } };
  listResponder = (url) => url.includes('state=open')
    ? new Promise<Response>(res => { releaseOpen = () => res(json({ person: 'paul', items })); })
    : json({ person: 'paul', items: [resolvedItem] });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  await click([...host.querySelectorAll('[role="tab"]')].find(b => b.textContent?.startsWith('Resolved'))); await settle();
  await act(async () => { releaseOpen(); }); await settle();
  expect([...host.querySelectorAll('[data-inbox-item]')].map(e => e.getAttribute('data-inbox-item'))).toEqual(['done1']);
  await act(async () => root.unmount());
  listResponder = () => json({ person: 'paul', items });
});

// openchamber#365 review round 2: an action or its Undo finishing after a tab change refreshes the tab shown, never the
// one it started on; clicking the tab already shown changes nothing.
const resolvedItem = { ...base, id: 'done1', title: 'Already resolved', actions: ['accept'], priority: 'normal', resolved: { at: '2026-09-28T11:00:00.000Z', by: 'paul' } };
const byState = (url: string) => json({ person: 'paul', items: url.includes('state=resolved') ? [resolvedItem] : items });
const ids = (host: { querySelectorAll: (s: string) => Iterable<{ getAttribute: (a: string) => string | null }> }) => [...host.querySelectorAll('[data-inbox-item]')].map(e => e.getAttribute('data-inbox-item'));
// After a tab change, each later Open request waits for release (so the badge's own refresh cannot mask a stale reload).
const gateOpen = () => { const gates: (() => void)[] = [];
  listResponder = url => url.includes('state=open') ? new Promise<Response>(res => { gates.push(() => res(byState(url))); }) : byState(url);
  // Answers the first waiting Open request (the stale reload, if any) and checks the list; then answers the rest.
  return async (check: () => void) => { if (gates.length) { await act(async () => { gates.shift()!(); }); await settle(); } check();
    while (gates.length) { await act(async () => { gates.shift()!(); }); await settle(); } check(); }; };
const tabButton = (host: { querySelectorAll: (s: string) => Iterable<{ textContent: string | null }> }, label: string) => [...host.querySelectorAll('[role="tab"]')].find(b => b.textContent?.startsWith(label));

test('an Accept answered after a tab change refreshes the tab shown, not Open', async () => {
  listResponder = byState;
  let releasePost!: () => void; postGate = new Promise<void>(r => { releasePost = r; });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Accept'))); await settle();
  await click(tabButton(host, 'Resolved')); await settle();
  expect(ids(host)).toEqual(['done1']);
  const releaseOpen = gateOpen();
  postGate = null; await act(async () => { releasePost(); }); await settle();
  await releaseOpen(() => expect(ids(host)).toEqual(['done1']));
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Already resolved');
  await act(async () => root.unmount());
});

test('an Undo after a tab change refreshes the tab shown, not Open', async () => {
  listResponder = byState;
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Accept'))); await settle();
  await click(tabButton(host, 'Resolved')); await settle();
  const releaseOpen = gateOpen();
  await act(async () => { toasts.at(-1)!.undo!(); }); await settle();
  expect(posts.at(-1)).toEqual({ url: '/api/inbox/p0x/reopen', body: {} });
  await releaseOpen(() => expect(ids(host)).toEqual(['done1']));
  await act(async () => root.unmount());
});

test('clicking the tab already shown keeps the list, the shown item and the response being typed', async () => {
  listResponder = byState;
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  await click([...host.querySelectorAll('article button')].find(b => b.textContent?.includes('Respond')));
  const box = host.querySelector('textarea') as unknown as HTMLTextAreaElement;
  await act(async () => { (Object.entries(box).find(([k]) => k.startsWith('__reactProps$'))![1] as { onChange: (e: unknown) => void }).onChange({ target: { value: 'draft' } }); });
  await click(tabButton(host, 'Open')); await settle();
  expect(ids(host)).toEqual(['p0x', 'ask:1']);
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Codex accounts nearly out');
  expect((host.querySelector('textarea') as unknown as HTMLTextAreaElement | null)?.value).toBe('draft');
  await act(async () => root.unmount());
  listResponder = () => json({ person: 'paul', items });
});

test('a card shows the title, why and "Recommended:" only: never item.source (internal notes) or a priority badge', async () => {
  listResponder = () => json({ person: 'paul', items });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  const cards = [...host.querySelectorAll('[data-inbox-item]')];
  // P0 still sorts first, without a badge.
  expect(cards.map(card => card.getAttribute('data-inbox-item'))).toEqual(['p0x', 'ask:1']);
  expect(cards.map(card => card.textContent)).toEqual(['Codex accounts nearly outRecommended: Add accounts.', 'Only a responseBecause.']);
  expect(host.textContent).not.toContain('net-lead');
  expect(host.textContent).not.toContain('P0');
  // The detail view shows no source either.
  expect(host.querySelector('article')?.textContent).not.toContain('net-lead');
  await act(async () => root.unmount());
});

test('the Open count is the number of items the Open list returned, not a separate total', async () => {
  listResponder = () => json({ person: 'paul', items });
  const { useInboxStore } = await import('@/lib/smartyInbox');
  useInboxStore.setState({ openCount: 17 });
  const host = win.document.createElement('div'); win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<View />)); await settle();
  expect([...host.querySelectorAll('[role="tab"]')][0]?.textContent).toBe('Open 2');
  await act(async () => root.unmount());
});
