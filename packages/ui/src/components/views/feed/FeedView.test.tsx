import { afterAll, beforeEach, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { FeedQuery, SmartiesResult, SmartyFeed } from '@/lib/smarties';
import type { FeedServices } from './FeedView';

// smarty-code#1407: the Smarties against fakes of the gateway's /api/me/smarties contract: the own Smarty is selected on
// load, another person's is view only, the inbox sits inside the own view, the old view hides behind one nav button,
// and the view paints from the first feed answer.
const paul: SmartiesResult = { state: 'ready', me: 'paul', smarties: [
  { id: 'paul', label: 'Paul’s Smarty', own: true, writable: true }, { id: 'kate', label: 'Kate’s Smarty', own: false, writable: false }] };
const inboxItem = { id: 'i1', to: 'paul', title: 'Approve the release', why: 'It is ready.', recommendation: 'Approve.', actions: ['respond'],
  links: [], priority: 'normal', created: '2026-10-07T04:00:00.000Z', updated: '2026-10-07T04:00:00.000Z' };

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, customElements: win.customElements, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  // The inbox reads /api/inbox: one open item the person can answer.
  fetch: async () => new Response(JSON.stringify({ person: 'paul', items: [inboxItem] }), { status: 200, headers: { 'content-type': 'application/json' } }) };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
// The transcript uses the chat's Markdown renderer, whose modules use Vite transforms Bun lacks.
await plugin({ name: 'feed-view-vite-transforms', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: "export default 'data:text/javascript,'", loader: 'js' }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => {
    const logos = Object.fromEntries(readdirSync(fileURLToPath(new URL('../../../assets/provider-logos/', import.meta.url)))
      .filter((name) => name.endsWith('.svg')).map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await readFile(path, 'utf8');
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { FeedView } = await import('./FeedView');
const { SmartiesNavSection, ClassicViewToggle } = await import('./FeedNav');
const { useFeedStore, ensureSmartiesLoaded, draftKey, smartyHeaderTitle } = await import('./feedStore');
const { SidebarNav } = await import('@/components/session/sidebar/shell/SidebarNav');
const { I18nProvider } = await import('@/lib/i18n');
const { useInboxStore } = await import('@/lib/smartyInbox');
const { SmartiesRequestError } = await import('@/lib/smarties');

afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

const paulFeed = { blocks: [{ id: 'b1', author: 'org', at: '11:55 PM ET', text: 'Good evening, Paul.' }, { id: 'b2', author: 'paul', at: '11:56 PM ET', text: 'Hi' }], offset: 120 } satisfies SmartyFeed;
const kateFeed = { blocks: [{ id: 'k1', author: 'org', at: '10:00 PM ET', text: 'Hello Kate.' }], offset: 40 } satisfies SmartyFeed;
const feedOf = (id: string) => (id === 'kate' ? kateFeed : paulFeed);
let feedGate: Promise<void> = Promise.resolve();
let sendResult: () => Promise<void> = async () => undefined;
const sent: { id: string; text: string; clientId: string }[] = [];
const services: Partial<FeedServices> = {
  loadFeed: async id => { await feedGate; return feedOf(id); },
  openStream: () => ({ close: () => undefined }),
  send: async (id, text, clientId) => { sent.push({ id, text, clientId }); return sendResult(); },
  // The chat's Markdown renderer needs the app's runtime providers; its rendering is the chat's own, not this view's.
  Text: ({ content }) => <p>{content}</p>,
};

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>)); await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
};
const view = (compact = false) => <FeedView compact={compact} onClose={() => useFeedStore.getState().setPageOpen(false)} services={services} />;
const pressEnter = (target: Element) => act(async () => {
  const props = Object.entries(target).find(([key]) => key.startsWith('__reactProps$'))?.[1];
  props?.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => undefined, nativeEvent: { isComposing: false } });
});
const button = (host: Element, text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text);

beforeEach(async () => {
  localStorage.clear();
  useFeedStore.setState({ view: 'smarty', selectedId: null, pageOpen: true, smarties: { state: 'loading' }, drafts: {}, failedSends: {}, pendingSends: {} });
  await ensureSmartiesLoaded(async () => paul, true);
  useInboxStore.setState({ available: true, openCount: 1 });
  feedGate = Promise.resolve(); sendResult = async () => undefined; sent.length = 0;
});

test('1–2: the nav lists the Smarties the person may see, own first, and selects the own one on load', async () => {
  const { host, unmount } = await mount(<SmartiesNavSection />);
  // smarty-code#1477: the own Smarty under "Your Smarty", named as theirs for keyboard and screen-reader users; the others under "Smarties".
  expect(Array.from(host.querySelectorAll('h2')).map(h => h.textContent)).toEqual(['Your Smarty', 'Smarties']);
  expect(Array.from(host.querySelectorAll('[data-smarty-own]')).map(row => [row.getAttribute('data-smarty-row'), row.getAttribute('aria-label')]))
    .toEqual([['paul', 'Your Smarty: Paul’s Smarty']]);
  expect(host.querySelector('[data-smarty-row="kate"]')?.getAttribute('aria-label')).toBeNull();
  expect(Array.from(host.querySelectorAll('[data-smarty-row]')).map(row => row.textContent)).toEqual(['Paul’s Smarty', 'Kate’s Smarty']);
  expect(host.querySelector('[aria-current="page"]')?.getAttribute('data-smarty-row')).toBe('paul');
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-smarty-row="kate"]')!.click(); });
  expect(useFeedStore.getState().selectedId).toBe('kate');
  expect(host.querySelector('[aria-current="page"]')?.getAttribute('data-smarty-row')).toBe('kate');
  await unmount();
});

test('smarty-code#1477: the own Smarty comes first even when the server lists it last; no own Smarty means only "Smarties"', async () => {
  await ensureSmartiesLoaded(async () => ({ state: 'ready', me: 'paul', smarties: [...(paul.state === 'ready' ? paul.smarties : [])].reverse() }), true);
  const own = await mount(<SmartiesNavSection />);
  expect(Array.from(own.host.querySelectorAll('h2, [data-smarty-row]')).map(e => e.textContent)).toEqual(['Your Smarty', 'Paul’s Smarty', 'Smarties', 'Kate’s Smarty']);
  await own.unmount();
  await ensureSmartiesLoaded(async () => ({ state: 'ready', me: 'ann', smarties: [{ id: 'kate', label: 'Kate’s Smarty', own: false, writable: false }] }), true);
  const none = await mount(<SmartiesNavSection />);
  expect(Array.from(none.host.querySelectorAll('h2')).map(h => h.textContent)).toEqual(['Smarties']);
  expect(none.host.querySelector('[data-smarty-own]')).toBeNull();
  await none.unmount();
});

test('1: a server without Smarties shows no section and keeps the old view', async () => {
  await ensureSmartiesLoaded(async () => ({ state: 'unavailable' }), true);
  const { host, unmount } = await mount(<><SmartiesNavSection /><ClassicViewToggle /></>);
  expect(host.textContent).toBe('');
  expect(useFeedStore.getState().pageOpen).toBe(false);
  await unmount();
});

test('smarty-code#1456: a signed-in member with no Smarties lands on "No Smarties to show yet" and reaches the old view by its button', async () => {
  await ensureSmartiesLoaded(async () => ({ state: 'empty' }), true);
  expect(useFeedStore.getState().pageOpen).toBe(true);
  const nav = await mount(<><SmartiesNavSection /><ClassicViewToggle /></>);
  expect(nav.host.querySelector('h2')?.textContent).toBe('Smarties');
  expect(nav.host.textContent).toContain('No Smarties to show yet.');
  expect(nav.host.querySelector('[role="alert"]')).toBeNull();
  const main = await mount(view());
  expect(main.host.querySelector('[data-smarties-empty]')?.textContent).toContain('No Smarties to show yet.');
  expect(main.host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { button(main.host, 'Smarty Code')!.click(); });
  expect(useFeedStore.getState().pageOpen).toBe(false);
  expect(button(nav.host, 'Back to Smarties')).toBeDefined();
  await main.unmount(); await nav.unmount();
});

test('smarty-code#1488: the message box keeps phone spell check, autocorrect and sentence capitals on', async () => {
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  expect([box.getAttribute('spellcheck'), box.getAttribute('autocorrect'), box.getAttribute('autocapitalize')]).toEqual(['true', 'on', 'sentences']);
  await unmount();
});

test('3: the own Smarty shows the conversation, the inbox inside it, and a "Message Paul’s Smarty" box that sends', async () => {
  const { host, unmount } = await mount(view());
  expect(host.querySelector('h1')?.textContent).toBe('Paul’s Smarty');
  expect(host.textContent).toContain('Good evening, Paul.');
  // The person's own blocks read "You"; no ids show.
  expect(Array.from(host.querySelectorAll('[data-feed-entry] span.font-semibold')).map(s => s.textContent)).toEqual(['Paul’s Smarty', 'You']);
  expect(host.querySelector('aside')?.textContent).toContain('Approve the release');
  // The inbox's reply button names the owner's Smarty.
  await act(async () => { host.querySelector<HTMLButtonElement>('aside [data-inbox-item="i1"]')!.click(); }); await settle();
  expect(button(host, 'Message Paul’s Smarty')).toBeDefined();
  const box = host.querySelector('textarea')!;
  expect(box.getAttribute('placeholder')).toBe('Message Paul’s Smarty');
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  expect(sent.map(({ id, text }) => ({ id, text }))).toEqual([{ id: 'paul', text: 'Ship it' }]);
  expect(box.value).toBe('');
  await unmount();
});

test('3: a failed send stays apart from the draft; Send again retries exactly it, with its client ID', async () => {
  sendResult = async () => { throw new Error('502'); };
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  // The failed message waits beside the box; the box stays the person's (here, empty).
  expect(box.value).toBe('');
  expect(host.querySelector('form [role="alert"]')?.textContent).toContain('Your message was not sent.');
  expect(host.querySelector('form [role="alert"]')?.textContent).toContain('Ship it');
  sendResult = async () => undefined;
  await act(async () => { button(host, 'Send again')!.click(); }); await settle();
  expect(sent.map(({ text }) => text)).toEqual(['Ship it', 'Ship it']);
  expect(sent[1]!.clientId).toBe(sent[0]!.clientId);
  expect(host.querySelector('form [role="alert"]')).toBeNull();
  await unmount();
});

test('3: a refused send (413) keeps the text in the box and shows the gateway’s own words under it', async () => {
  sendResult = async () => { throw new SmartiesRequestError(413, 'Message is too long. The limit is 120 KB.'); };
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  expect(sent.map(({ text }) => text)).toEqual(['Ship it']);
  expect(box.value).toBe('Ship it');
  const alert = host.querySelector('form [role="alert"]');
  expect(alert?.textContent).toBe('Message is too long. The limit is 120 KB.');
  expect(alert?.className).toContain('status-error');
  // A refusal is not a lost answer: nothing waits beside the box to be sent again, and no sending line stays.
  expect(button(host, 'Send again')).toBeUndefined();
  expect(useFeedStore.getState().pendingSends[draftKey('paul')] ?? []).toEqual([]);
  // Editing the text clears the notice; the next send is a new message under a new client ID.
  sendResult = async () => undefined;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it, shorter'); });
  await pressEnter(box); await settle();
  expect(sent[1]).toMatchObject({ text: 'Ship it, shorter' });
  expect(sent[1]!.clientId).not.toBe(sent[0]!.clientId);
  expect(box.value).toBe('');
  expect(host.querySelector('form [role="alert"]')).toBeNull();
  await unmount();
});

test('3: a 5xx with a message shows that message but is not a refusal: it waits for Send again under the SAME client ID (#567 r3)', async () => {
  sendResult = async () => { throw new SmartiesRequestError(500, 'The Smarty is restarting. Try again in a minute.'); };
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  // The server may have accepted it: the box is not refilled, the message waits beside it, the server's words show.
  expect(box.value).toBe('');
  expect(host.querySelector('form [role="alert"]')?.textContent).toContain('The Smarty is restarting. Try again in a minute.');
  sendResult = async () => undefined;
  await act(async () => { button(host, 'Send again')!.click(); }); await settle();
  expect(sent.map(({ text }) => text)).toEqual(['Ship it', 'Ship it']);
  expect(sent[1]!.clientId).toBe(sent[0]!.clientId);
  await unmount();
});

test('3: a message over 120,000 UTF-8 bytes is not sent; the text stays with a plain note', async () => {
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  const tooLong = 'This message is too long to send (over 120 KB). Try splitting it into parts.';
  // 60,001 two-byte characters: under 120,000 characters, over 120,000 bytes.
  const pasted = '\u00e9'.repeat(60_001);
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), pasted); });
  await pressEnter(box); await settle();
  expect(sent).toEqual([]);
  expect(box.value).toBe(pasted);
  expect(host.querySelector('form [role="alert"]')?.textContent).toBe(tooLong);
  // Exactly at the limit still sends, and the box clears as usual.
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'x'.repeat(120_000)); });
  await pressEnter(box); await settle();
  expect(sent.map(({ text }) => text.length)).toEqual([120_000]);
  expect(box.value).toBe('');
  expect(host.querySelector('form [role="alert"]')).toBeNull();
  await unmount();
});

test('3: Send again holds the same 120,000-byte limit; an over-limit failed entry is kept, not sent (#567 review)', async () => {
  const { host, unmount } = await mount(view());
  const pasted = '\u00e9'.repeat(60_001);
  await act(async () => { useFeedStore.getState().addFailedSend(draftKey('paul'), { text: pasted, clientId: 'msg-old', at: Date.now() }); });
  await settle();
  await act(async () => { button(host, 'Send again')!.click(); }); await settle();
  expect(sent).toEqual([]);
  expect(host.querySelector('form [role="alert"]')?.textContent).toContain('This message is too long to send (over 120 KB).');
  expect((useFeedStore.getState().failedSends[draftKey('paul')] ?? []).map(({ clientId }) => clientId)).toEqual(['msg-old']);
  await unmount();
});

test('3: a 4xx refusal with NO message still counts as refused: the text comes back and the next send uses a new client ID (#567 r4)', async () => {
  sendResult = async () => { throw new SmartiesRequestError(413); };
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  expect(box.value).toBe('Ship it');
  expect(button(host, 'Send again')).toBeUndefined();
  sendResult = async () => undefined;
  await pressEnter(box); await settle();
  expect(sent[1]!.clientId).not.toBe(sent[0]!.clientId);
  await unmount();
});

test('3: a refused send that waits beside the box (new text was typed) retries under a NEW client ID (#567 review)', async () => {
  let refuse!: (error: Error) => void;
  sendResult = () => new Promise<void>((_, reject) => { refuse = reject; });
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box);
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Something new'); });
  const before = Date.now();
  await act(async () => { refuse(new SmartiesRequestError(413, 'This message is too long to send.')); }); await settle();
  expect(box.value).toBe('Something new');
  // A fresh 24 h window too: the retry is a new message, so its age starts now (#567 r3).
  expect((useFeedStore.getState().failedSends[draftKey('paul')] ?? [])[0]!.at).toBeGreaterThanOrEqual(before);
  sendResult = async () => undefined;
  await act(async () => { button(host, 'Send again')!.click(); }); await settle();
  expect(sent.map(({ text }) => text)).toEqual(['Ship it', 'Ship it']);
  expect(sent[1]!.clientId).not.toBe(sent[0]!.clientId);
  await unmount();
});

test('3: an accepted send whose answer was lost, then more typing: the retry is the original alone, the new draft untouched (P2)', async () => {
  sendResult = async () => { throw new Error('response lost'); };
  const { host, unmount } = await mount(view());
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(box); await settle();
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'And the docs'); });
  sendResult = async () => undefined;
  await act(async () => { button(host, 'Send again')!.click(); }); await settle();
  expect(sent.map(({ text, clientId }) => ({ text, clientId }))).toEqual([{ text: 'Ship it', clientId: sent[0]!.clientId }, { text: 'Ship it', clientId: sent[0]!.clientId }]);
  expect(box.value).toBe('And the docs');
  // The new draft sends on its own, under its own client ID.
  await pressEnter(box); await settle();
  expect(sent[2]).toMatchObject({ text: 'And the docs' });
  expect(sent[2]!.clientId).not.toBe(sent[0]!.clientId);
  await unmount();
});

const withFetch = async (respond: (url: string) => Response, run: () => Promise<void>) => {
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string | URL | Request) => respond(input instanceof Request ? input.url : String(input)) });
  try { await run(); } finally { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: realFetch }); }
};
/** The gateway's /api/inbox answers: a list (a shared one says readOnly and grants no capabilities), or a refusal. */
type InboxAnswer = { person: string; items: (typeof inboxItem)[]; readOnly?: true; capabilities?: Record<string, never> } | { data: { message: string } };
const json = (body: InboxAnswer, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('4: another person’s Smarty is view only: transcript, no message box, and no inbox when theirs is not shared (a 403 shows nothing)', async () => {
  const urls: string[] = [];
  await withFetch(url => { urls.push(url); return url.includes('person=') ? json({ data: { message: 'This inbox is not shared with you' } }, 403) : json({ person: 'paul', items: [inboxItem] }); }, async () => {
    useFeedStore.getState().selectSmarty('kate');
    const { host, unmount } = await mount(view());
    expect(host.querySelector('h1')?.textContent).toBe('Kate’s Smarty');
    expect(host.textContent).toContain('Hello Kate.');
    expect(host.textContent).toContain('View only');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('aside')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).toEqual([]);
    expect(urls.some(url => url.includes('/api/inbox?state=open&person=kate'))).toBe(true);
    await unmount();
  });
});

test('smarty-code#1476: a principal sees another principal’s shared inbox read only: items and tabs, no answer, snooze or resolve', async () => {
  const kateItem = { ...inboxItem, id: 'k-i1', to: 'kate', title: 'Sign the lease', actions: ['accept', 'respond', 'ignore'] };
  const urls: string[] = [];
  let changed: () => void = () => undefined;
  const watched: string[] = [];
  const shared: Partial<FeedServices> = { ...services, watchInbox: (person, onChange) => { watched.push(person); changed = onChange; return () => undefined; } };
  let kateItems = [kateItem];
  await withFetch(url => {
    urls.push(url);
    if (url.includes('person=kate')) return json({ person: 'kate', items: url.includes('state=open') ? kateItems : [], readOnly: true, capabilities: {} });
    return json({ person: 'paul', items: [inboxItem] });
  }, async () => {
    useFeedStore.getState().selectSmarty('kate');
    const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={shared} />);
    expect(watched).toEqual(['kate']);
    const aside = host.querySelector('aside')!;
    expect(button(host, 'Inbox (1)')?.getAttribute('aria-pressed')).toBe('true');
    expect(aside.querySelector('[data-inbox-read-only]')?.textContent).toBe('Read only');
    expect(Array.from(aside.querySelectorAll('[role="tab"]')).map(tab => tab.textContent)).toEqual(['Open 1', 'Snoozed', 'Resolved']);
    await act(async () => { aside.querySelector<HTMLButtonElement>('[data-inbox-item="k-i1"]')!.click(); }); await settle();
    const article = host.querySelector('aside article')!;
    expect(article.textContent).toContain('Sign the lease');
    // Only the way back to the list: no Accept, Respond, Snooze, Ignore or Reopen.
    expect(Array.from(article.querySelectorAll('button')).map(b => b.textContent?.trim())).toEqual(['Inbox']);
    expect(host.querySelector('textarea')).toBeNull();
    // A change on Kate's inbox stream reads her list again.
    kateItems = [kateItem, { ...kateItem, id: 'k-i2', title: 'Book the flight' }];
    await act(async () => { changed(); }); await settle();
    expect(button(host, 'Inbox (2)')).toBeDefined();
    await unmount();
  });
  // Every inbox read was Kate's, never the signed-in person's.
  expect(urls.filter(url => url.includes('/api/inbox')).every(url => url.includes('person=kate'))).toBe(true);
  expect(urls.some(url => url.includes('state=open&person=kate'))).toBe(true);
});

test('smarty-code#1476: on a phone the shared inbox opens as the same read-only sheet', async () => {
  await withFetch(url => url.includes('person=kate') ? json({ person: 'kate', items: [{ ...inboxItem, id: 'k-i1', to: 'kate', title: 'Sign the lease' }], readOnly: true, capabilities: {} })
    : json({ person: 'paul', items: [inboxItem] }), async () => {
    useFeedStore.getState().selectSmarty('kate');
    const { host, unmount } = await mount(view(true));
    await act(async () => { button(host, 'Inbox (1)')!.click(); }); await settle();
    const sheet = document.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain('Sign the lease');
    expect(sheet.querySelector('[data-inbox-read-only]')?.textContent).toBe('Read only');
    await act(async () => { button(document.body, 'Close inbox')?.click(); }); await settle();
    await unmount();
  });
});

test('5: the old view is hidden by default; the one bottom button switches to it and back, for this visit only', async () => {
  const { host, unmount } = await mount(<ClassicViewToggle />);
  const toggle = host.querySelector('button')!;
  expect(toggle.textContent).toBe('Smarty Code');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await act(async () => { toggle.click(); });
  expect(useFeedStore.getState().pageOpen).toBe(false);
  expect(toggle.textContent).toBe('Back to Smarties');
  await act(async () => { toggle.click(); });
  expect(useFeedStore.getState().pageOpen).toBe(true);
  // Nothing is remembered on the device: the next load lands on the own Smarty again.
  expect(localStorage.length).toBe(0);
  await unmount();
});

test('1: every load lands on the own Smarty: the app’s automatic closes (a session restored on load) do not leave it', async () => {
  useFeedStore.getState().setPageOpen(false);
  expect(useFeedStore.getState().pageOpen).toBe(true);
  expect(useFeedStore.getState().selectedId).toBe('paul');
  // A load where the person's Smarty is listed second still selects their own (own is listed first by the client).
  await ensureSmartiesLoaded(async () => ({ state: 'ready', me: 'kate', smarties: [
    { id: 'kate', label: 'Kate’s Smarty', own: true, writable: true }, { id: 'paul', label: 'Paul’s Smarty', own: false, writable: false }] }), true);
  useFeedStore.setState({ selectedId: null });
  await ensureSmartiesLoaded(async () => ({ state: 'ready', me: 'kate', smarties: [
    { id: 'kate', label: 'Kate’s Smarty', own: true, writable: true }, { id: 'paul', label: 'Paul’s Smarty', own: false, writable: false }] }), true);
  expect(useFeedStore.getState().selectedId).toBe('kate');
});

test('2: while a Smarty fills the app, the top bar names it; in the old view it names nothing of ours', async () => {
  expect(smartyHeaderTitle(useFeedStore.getState())).toBe('Paul’s Smarty');
  useFeedStore.getState().selectSmarty('kate');
  expect(smartyHeaderTitle(useFeedStore.getState())).toBe('Kate’s Smarty');
  useFeedStore.getState().showClassic();
  expect(smartyHeaderTitle(useFeedStore.getState())).toBeNull();
});

test('3: in the Smarty view the nav is only the Smarties section; the old view adds New session back', async () => {
  const { host, unmount } = await mount(<SidebarNav onNewSession={() => undefined} />);
  expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Paul’s Smarty', 'Kate’s Smarty']);
  await act(async () => { useFeedStore.getState().showClassic(); });
  expect(host.textContent).toContain('New session');
  await unmount();
});

test('5: on a phone the Inbox opens as a sheet and the header holds the Smarty switch and the old-view button', async () => {
  const { host, unmount } = await mount(view(true));
  expect(Array.from(host.querySelectorAll('[role="group"] button')).map(b => [b.textContent, b.getAttribute('aria-pressed')]))
    .toEqual([['Paul’s Smarty', 'true'], ['Kate’s Smarty', 'false']]);
  const inbox = button(host, 'Inbox (1)')!;
  await act(async () => { inbox.click(); }); await settle();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Approve the release');
  await act(async () => { button(document.body, 'Close inbox')?.click(); }); await settle();
  await act(async () => { button(host, 'Smarty Code')!.click(); });
  expect(useFeedStore.getState().pageOpen).toBe(false);
  expect(useFeedStore.getState().view).toBe('classic');
  await unmount();
});

test('7: no flicker: nothing paints before the first feed answer, then the whole view at once', async () => {
  let open: () => void = () => undefined;
  feedGate = new Promise(resolve => { open = resolve; });
  const { host, unmount } = await mount(view());
  expect(host.textContent).toBe('');
  expect(host.querySelector('h1')).toBeNull();
  await act(async () => { open(); }); await settle();
  expect(host.querySelector('h1')?.textContent).toBe('Paul’s Smarty');
  expect(host.textContent).toContain('Good evening, Paul.');
  await unmount();
});

test('7: live blocks append without duplicates, and a dropped stream catches up from the last offset', async () => {
  let handlers: Parameters<FeedServices['openStream']>[1] | null = null;
  const reads: (number | undefined)[] = [];
  const live: Partial<FeedServices> = { ...services, openStream: (_id, h) => { handlers = h; return { close: () => undefined }; },
    loadFeed: async (id, query) => {
      reads.push(query?.after);
      if (query?.after === undefined) return feedOf(id);
      // Nothing was appended before the stream attached; the reconnect catch-up finds one block.
      return query.after === 120 ? { blocks: [], offset: 120 } : { blocks: [{ id: 'b4', author: 'org', at: '12:01 AM ET', text: 'Caught up.' }], offset: 200 };
    } };
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={live} />);
  await act(async () => { handlers!.onBlocks({ blocks: [paulFeed.blocks[1], { id: 'b3', author: 'org', at: '12:00 AM ET', text: 'New one.' }], offset: 160 }); });
  expect(host.querySelectorAll('[data-feed-entry]')).toHaveLength(3);
  await act(async () => { handlers!.onReconnect(); }); await settle();
  // The first read, the catch-up right after the stream attaches (from 120), and the reconnect catch-up (from 160).
  expect(reads).toEqual([undefined, 120, 160]);
  expect(host.textContent).toContain('Caught up.');
  await unmount();
});

test('a failed list read is a failure with Try again, never "no Smarties"', async () => {
  await ensureSmartiesLoaded(async () => { throw new Error('500'); }, true);
  const { host, unmount } = await mount(view());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not load the Smarties.');
  expect(useFeedStore.getState().pageOpen).toBe(true);
  await unmount();
});

test('a failed send keeps its client ID with the draft: closing and reopening the view still reuses it', async () => {
  sendResult = async () => { throw new Error('lost'); };
  const first = await mount(view());
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(first.host.querySelector('textarea')!); await settle();
  await first.unmount();
  sendResult = async () => undefined;
  const second = await mount(view());
  await act(async () => { button(second.host, 'Send again')!.click(); }); await settle();
  expect(sent[1]!.clientId).toBe(sent[0]!.clientId);
  await second.unmount();
});

test('a failed catch-up read retries from the same offset until it succeeds', async () => {
  const reads: (number | undefined)[] = [];
  let fail = true;
  const flaky: Partial<FeedServices> = { ...services, loadFeed: async (id, query) => {
    const after = query?.after;
    reads.push(after);
    if (after === undefined) return feedOf(id);
    if (fail) { fail = false; throw new Error('503'); }
    return { blocks: [{ id: 'gap', author: 'org', at: '12:02 AM ET', text: 'Written while away.' }], offset: 300 };
  } };
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={flaky} />);
  await act(async () => { await new Promise(r => setTimeout(r, 1100)); });
  expect(reads).toEqual([undefined, 120, 120]);
  expect(host.textContent).toContain('Written while away.');
  await unmount();
});

const block = (n: number) => ({ id: `n${n}`, author: 'org', at: '1:00 AM ET', text: `Block ${n}` });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => block(from + i));

test('first paint is the newest 50 blocks; "Show earlier" reveals held blocks, then pages back 100 with before=', async () => {
  const queries: (FeedQuery | undefined)[] = [];
  // The server ignored `limit` and sent 60 blocks (40..99), starting at byte 4000.
  const paged: Partial<FeedServices> = { ...services, loadFeed: async (_id, query) => {
    queries.push(query);
    if (query?.before !== undefined) return { blocks: range(0, 40), offset: 4000, earlier: null };
    if (query?.after !== undefined) return { blocks: [], offset: 9000 };
    return { blocks: range(40, 100), offset: 9000, earlier: 4000 };
  } };
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={paged} />);
  expect(queries[0]).toEqual({ limit: 50 });
  const shown = () => Array.from(host.querySelectorAll('[data-feed-entry] p')).map(p => p.textContent);
  expect(shown()).toHaveLength(50);
  expect(shown()[0]).toBe('Block 50');
  expect(shown().at(-1)).toBe('Block 99');
  await act(async () => { button(host, 'Show earlier')!.click(); }); await settle();
  expect(shown()).toHaveLength(60);
  expect(queries.some(q => q?.before !== undefined)).toBe(false);
  await act(async () => { button(host, 'Show earlier')!.click(); }); await settle();
  expect(queries.at(-1)).toEqual({ before: 4000, limit: 100 });
  expect(shown()).toHaveLength(100);
  expect(shown()[0]).toBe('Block 0');
  // The top of the feed: no more earlier control.
  expect(button(host, 'Show earlier')).toBeUndefined();
  await unmount();
});

test('opening the Smarty view reads only /api/me/smarties feeds: never /api/session or any Pi session history', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const body = url.includes('/api/me/smarties/paul/feed') ? paulFeed : url.includes('/api/inbox') ? { person: 'paul', items: [inboxItem] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  try {
    // The app's own services (the gateway client), only the Markdown renderer replaced.
    const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={{ Text: services.Text }} />);
    expect(host.textContent).toContain('Good evening, Paul.');
    expect(urls.some(url => url.includes('/api/me/smarties/paul/feed'))).toBe(true);
    expect(urls.filter(url => /\/api\/session|\/session\b|\/message\b/.test(url))).toEqual([]);
    await unmount();
  } finally { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: realFetch }); }
});

test('Send again always retries under the same client ID, however late (the gateway dedupes it for 24 h; openchamber#558 P2)', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    // Accepted by the gateway, but its answer was lost.
    sendResult = async () => { throw new Error('response lost'); };
    const { host, unmount } = await mount(view());
    await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
    await pressEnter(host.querySelector('textarea')!); await settle();
    // Retried an hour later.
    now += 60 * 60_000;
    sendResult = async () => undefined;
    await act(async () => { button(host, 'Send again')!.click(); }); await settle();
    expect(sent.map(({ text }) => text)).toEqual(['Ship it', 'Ship it']);
    expect(sent[1]!.clientId).toBe(sent[0]!.clientId);
    await unmount();
  } finally { Date.now = realNow; }
});

test('3: the own Smarty always holds the inbox column, with a plain empty state when nothing needs the person', async () => {
  // A person whose inbox list is unavailable or empty (Kate's first morning) still sees the column.
  useInboxStore.setState({ available: false, openCount: 0 });
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => new Response(JSON.stringify({ person: 'paul', items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  try {
    const { host, unmount } = await mount(view());
    expect(host.querySelector('aside')?.textContent).toContain('Nothing here.');
    await unmount();
  } finally { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: realFetch }); }
});

test('the backfill format: "you" lines are the owner’s (right-aligned, named), and the earlier-conversation block is a divider', async () => {
  const backfill: Partial<FeedServices> = { ...services, loadFeed: async (_id, query) => query?.after !== undefined ? { blocks: [], offset: 90 } : { offset: 90, blocks: [
    { id: 'd1', author: 'org', at: '8:00 PM ET', text: '— Earlier conversation with your Smarty —' },
    { id: 'y1', author: 'you', at: '8:01 PM ET', text: 'Morning!' },
    { id: 'o1', author: 'org', at: '8:02 PM ET', text: 'Good morning, Kate.' },
    { id: 'k1', author: 'kate', at: '8:03 PM ET', text: 'Thanks.' },
  ] } };
  // Paul looks at Kate's Smarty: her lines read "Kate", on the right.
  useFeedStore.getState().selectSmarty('kate');
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={backfill} />);
  const divider = host.querySelector('[role="separator"][data-feed-divider]');
  expect(divider?.textContent).toBe('Earlier conversation with your Smarty');
  expect(host.querySelectorAll('[data-feed-entry]')).toHaveLength(3);
  const entries = Array.from(host.querySelectorAll('[data-feed-entry]')).map(e => [e.getAttribute('data-feed-entry'), e.querySelector('span.font-semibold')?.textContent]);
  expect(entries).toEqual([['owner', 'Kate'], ['smarty', 'Kate’s Smarty'], ['owner', 'Kate']]);
  expect(host.querySelector('[data-feed-entry="owner"]')?.className).toContain('items-end');
  await unmount();
  // Kate in her own Smarty: the same lines read "You".
  await ensureSmartiesLoaded(async () => ({ state: 'ready', me: 'kate', smarties: [{ id: 'kate', label: 'Kate’s Smarty', own: true, writable: true }] }), true);
  const own = await mount(<FeedView onClose={() => undefined} services={backfill} />);
  expect(Array.from(own.host.querySelectorAll('[data-feed-entry="owner"] span.font-semibold')).map(e => e.textContent)).toEqual(['You', 'You']);
  await own.unmount();
});

test('a sent message shows at once as the owner’s line, marked as sending, and stays until the feed’s own block replaces it', async () => {
  let handlers: Parameters<FeedServices['openStream']>[1] | null = null;
  const live: Partial<FeedServices> = { ...services, openStream: (_id, h) => { handlers = h; return { close: () => undefined }; },
    // An earlier identical line is already in the feed: it is not this send's echo.
    loadFeed: async (_id, query) => query?.after !== undefined ? { blocks: [], offset: 120 }
      : { blocks: [...paulFeed.blocks, { id: 'old-ok', author: 'you', at: '11:57 PM ET', text: 'ok' }], offset: 120 } };
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={live} />);
  const box = host.querySelector('textarea')!;
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'ok'); });
  await pressEnter(box); await settle();
  const pendingLine = () => host.querySelector('[data-feed-pending]');
  expect(pendingLine()?.textContent).toContain('Sending…');
  expect(pendingLine()?.textContent).toContain('ok');
  expect(pendingLine()?.className).toContain('items-end');
  // Accepted (202): it stays, still marked, while the feed has not echoed it.
  await settle();
  expect(pendingLine()).not.toBeNull();
  // Another person's line with the same text is not the echo.
  await act(async () => { handlers!.onBlocks({ blocks: [{ id: 'k9', author: 'org', at: '12:00 AM ET', text: 'ok' }], offset: 130 }); });
  expect(pendingLine()).not.toBeNull();
  // The gateway's '@@ you' line arrives on the stream: it replaces the pending line.
  await act(async () => { handlers!.onBlocks({ blocks: [{ id: 'echo', author: 'you', at: '12:01 AM ET', text: 'ok' }], offset: 140 }); }); await settle();
  expect(pendingLine()).toBeNull();
  expect(Array.from(host.querySelectorAll('[data-feed-entry="owner"]')).map(e => e.querySelector('p')?.textContent)).toEqual(['Hi', 'ok', 'ok']);
  await unmount();
});

test('a failed send leaves the transcript (it waits beside the box with Send again), never as a sending line', async () => {
  sendResult = async () => { throw new Error('502'); };
  const { host, unmount } = await mount(view());
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(host.querySelector('textarea')!); await settle();
  expect(host.querySelector('[data-feed-pending]')).toBeNull();
  expect(button(host, 'Send again')).toBeDefined();
  await unmount();
});

test('the Smarty view lifts the app’s loading splash once it has painted from its feed', async () => {
  const splash = document.createElement('div'); splash.id = 'initial-loading'; document.body.appendChild(splash);
  let open: () => void = () => undefined;
  feedGate = new Promise(resolve => { open = resolve; });
  const { unmount } = await mount(view());
  expect(splash.classList.contains('fade-out')).toBe(false);
  await act(async () => { open(); }); await settle();
  expect(splash.classList.contains('fade-out')).toBe(true);
  await act(async () => { await new Promise(r => setTimeout(r, 350)); });
  expect(document.getElementById('initial-loading')).toBeNull();
  await unmount();
});

test('past 24 h from its first send, a failed message offers Copy text and a plain note, not Send again (#558 P2b)', async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  sendResult = async () => { throw new Error('response lost'); };
  const { host, unmount } = await mount(view());
  await act(async () => { useFeedStore.getState().setDraftAt(draftKey('paul'), 'Ship it'); });
  await pressEnter(host.querySelector('textarea')!); await settle();
  expect(button(host, 'Send again')).toBeDefined();
  // The same failed message, first sent a day and a minute ago: the gateway no longer dedupes it.
  const key = draftKey('paul');
  await act(async () => { useFeedStore.setState(state => ({ failedSends: { ...state.failedSends,
    [key]: (state.failedSends[key] ?? []).map(item => ({ ...item, at: Date.now() - 24 * 3_600_000 - 60_000 })) } })); });
  expect(button(host, 'Send again')).toBeUndefined();
  expect(host.querySelector('form [role="alert"]')?.textContent).toContain('This may already have been sent.');
  await act(async () => { button(host, 'Copy text')!.click(); }); await settle();
  expect(copied).toEqual(['Ship it']);
  expect(sent).toHaveLength(1);
  await unmount();
});

test('a catch-up answer that arrives after a newer stream block still lands before it, in server order (#558 P2a)', async () => {
  let handlers: Parameters<FeedServices['openStream']>[1] | null = null;
  let answerCatchUp: (feed: SmartyFeed) => void = () => undefined;
  const delayed: Partial<FeedServices> = { ...services, openStream: (_id, h) => { handlers = h; return { close: () => undefined }; },
    loadFeed: async (id, query) => query?.after === undefined ? feedOf(id) : new Promise<SmartyFeed>(resolve => { answerCatchUp = resolve; }) };
  const { host, unmount } = await mount(<FeedView onClose={() => undefined} services={delayed} />);
  // The stream delivers a newer block (ends at byte 300) while the catch-up for the gap is still out.
  await act(async () => { handlers!.onBlocks({ blocks: [{ id: 'new', author: 'org', at: '12:05 AM ET', text: 'Newer' }], offset: 300 }); });
  // The delayed catch-up answer: the block written before it (ends at byte 200).
  await act(async () => { answerCatchUp({ blocks: [{ id: 'missed', author: 'org', at: '12:00 AM ET', text: 'Missed' }], offset: 200 }); }); await settle();
  expect(Array.from(host.querySelectorAll('[data-feed-entry] p')).map(p => p.textContent)).toEqual(['Good evening, Paul.', 'Hi', 'Missed', 'Newer']);
  await unmount();
});

test('the own Smarty mounts exactly one inbox list: N cards for N items, at desktop and at phone width (#560)', async () => {
  const many = Array.from({ length: 18 }, (_, i) => ({ ...inboxItem, id: `item-${i}`, title: `Item ${i}` }));
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => new Response(JSON.stringify({ person: 'paul', items: many }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  const cards = () => [...document.querySelectorAll('[data-inbox-item]')].map(card => card.getAttribute('data-inbox-item'));
  try {
    const desktop = await mount(view());
    expect(cards()).toHaveLength(18);
    expect(new Set(cards()).size).toBe(18);
    await desktop.unmount();
    // A phone: no column; the sheet is the one list, and only while it is open.
    const phone = await mount(view(true));
    expect(cards()).toHaveLength(0);
    await act(async () => { button(phone.host, 'Inbox (1)')!.click(); }); await settle();
    expect(cards()).toHaveLength(18);
    expect(new Set(cards()).size).toBe(18);
    expect(document.querySelectorAll('[aria-label$="inbox items"]')).toHaveLength(1);
    await phone.unmount();
  } finally { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: realFetch }); }
});
