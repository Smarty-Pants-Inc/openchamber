import { afterAll, afterEach, expect, jest, test } from 'bun:test';
import { plugin } from 'bun';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { SmartiesResult, SmartyActivity, SmartyFeed } from '@/lib/smarties';
import type { FeedServices } from './FeedView';

// smarty-code#1490: each Smarty's status at a glance (dot and word, last activity), the live "Working… Ns" line in an open
// Smarty, and a phone-width header, against fakes of the gateway's activity fields.
const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, customElements: win.customElements, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: async () => new Response(JSON.stringify({ person: 'paul', items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
await plugin({ name: 'smarty-status-vite-transforms', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: "export default 'data:text/javascript,'", loader: 'js' }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => {
    const logos = Object.fromEntries(readdirSync(fileURLToPath(new URL('../../../assets/provider-logos/', import.meta.url)))
      .filter((name) => name.endsWith('.svg')).map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await readFile(path, 'utf8');
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { FeedView } = await import('./FeedView');
const { SmartiesNavSection } = await import('./FeedNav');
const { SmartyWorkingLine } = await import('./SmartyStatus');
const { useFeedStore, refreshSmarties } = await import('./feedStore');
const { I18nProvider } = await import('@/lib/i18n');
const { loadSmarties } = await import('@/lib/smarties');

afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
let fake = false;
const fakeClock = (now: number) => { jest.useFakeTimers({ now }); fake = true; };
afterEach(() => { jest.useRealTimers(); fake = false; document.body.innerHTML = ''; });

const T = Date.UTC(2026, 9, 8, 12);
const act0 = (state: SmartyActivity['state'], startedAt: number | null = null, lastActiveAt: number | null = T - 120_000): SmartyActivity => ({ state, startedAt, lastActiveAt });
const ready = (smarties: { id: string; activity?: SmartyActivity }[]): SmartiesResult => ({ state: 'ready', me: 'paul',
  smarties: smarties.map(({ id, activity }, i) => ({ id, label: `${id[0]!.toUpperCase()}${id.slice(1)}’s Smarty`, own: i === 0, writable: i === 0, ...(activity ? { activity } : {}) })) });
const feed = { blocks: [{ id: 'k1', author: 'org', at: '10:00 PM ET', text: 'Hello.' }], offset: 40 } satisfies SmartyFeed;
let onStatus: ((activity: SmartyActivity) => void) | undefined, onBlocks: ((next: SmartyFeed) => void) | undefined;
let loads = 0, streams = 0;
const services: Partial<FeedServices> = { loadFeed: async () => { loads++; return feed; }, send: async () => undefined, Text: ({ content }) => <p>{content}</p>,
  openStream: (_id, handlers) => { streams++; onStatus = handlers.onStatus; onBlocks = handlers.onBlocks; return { close: () => undefined }; } };
const settle = () => act(async () => { if (fake) jest.advanceTimersByTime(20); else await new Promise(r => setTimeout(r, 20)); });
const mount = async (node: React.ReactNode, width?: number) => {
  const host = document.createElement('div'); if (width) host.style.width = `${width}px`; document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>)); await settle();
  return { host, render: (next: React.ReactNode) => act(async () => root.render(<I18nProvider>{next}</I18nProvider>)), unmount: () => act(async () => root.unmount()) };
};
const rowStatus = (host: Element) => Array.from(host.querySelectorAll('[data-smarty-row]')).map(row => {
  const badge = row.querySelector('[data-smarty-status]');
  return [badge?.getAttribute('data-smarty-status'), badge?.textContent];
});

test('the nav shows each Smarty\'s state as a dot and a word, with its last activity; no field shows nothing', async () => {
  fakeClock(T);
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('working', T - 5_000, T) }, { id: 'kate', activity: act0('waiting') },
    { id: 'ann', activity: act0('idle') }, { id: 'bo', activity: act0('blocked', null, T - 3 * 3_600_000) }, { id: 'cy', activity: act0('offline', null, null) },
    { id: 'di', activity: act0('unknown') }, { id: 'ed' }]));
  const { host, unmount } = await mount(<SmartiesNavSection />);
  expect(rowStatus(host)).toEqual([['working', 'Working· Last active now'], ['waiting', 'Waiting· Last active 2m ago'], ['idle', 'Idle· Last active 2m ago'],
    ['blocked', 'Blocked· Last active 3h ago'], ['offline', 'Offline'], ['unknown', 'Status unknown· Last active 2m ago'], [undefined, undefined]]);
  // Not colour alone: the dot is hidden from assistive tech, the word is text; the visible time reads "2m ago".
  const waiting = host.querySelector('[data-smarty-status="waiting"]')!;
  expect(waiting.querySelector('[aria-hidden].rounded-full')).not.toBeNull();
  expect(waiting.getAttribute('title')).toBe('Waiting on a person');
  expect(waiting.querySelector('[data-smarty-last-active]')?.lastChild?.textContent).toBe('2m ago');
  await unmount();
});

test('"Working… Ns" ticks each second while the turn runs and clears when it ends; an unseen start shows no seconds', async () => {
  fakeClock(T);
  const { host, render, unmount } = await mount(<SmartyWorkingLine activity={act0('working', T - 12_000, T)} />);
  const line = () => host.querySelector('[data-smarty-working]');
  expect(line()?.textContent).toBe('Working…12s');
  expect(line()?.getAttribute('role')).toBe('status');
  await act(async () => { jest.advanceTimersByTime(3_000); });
  expect(line()?.textContent).toBe('Working…15s');
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(line()?.textContent).toBe('Working…1m 15s');
  await render(<SmartyWorkingLine activity={act0('working', null, T)} />);
  expect(line()?.textContent).toBe('Working…');
  await render(<SmartyWorkingLine activity={act0('idle')} />);
  expect(line()).toBeNull();
  await unmount();
});

test('an open Smarty takes its status live from its stream: the working line comes and goes', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('idle') }, { id: 'kate', activity: act0('idle') }]));
  useFeedStore.getState().selectSmarty('kate');
  const { host, unmount } = await mount(<FeedView services={services} />);
  expect(host.querySelector('header [data-smarty-status]')?.getAttribute('data-smarty-status')).toBe('idle');
  expect(host.querySelector('[data-smarty-working]')).toBeNull();
  await act(async () => { onStatus!({ state: 'working', startedAt: Date.now() - 4_000, lastActiveAt: Date.now() }); });
  expect(host.querySelector('[data-smarty-working]')?.textContent).toBe('Working…4s');
  expect(host.querySelector('header [data-smarty-status]')?.textContent).toBe('Working· Last active now');
  await act(async () => { onStatus!({ state: 'idle', startedAt: null, lastActiveAt: Date.now() }); });
  expect(host.querySelector('[data-smarty-working]')).toBeNull();
  expect(host.querySelector('header [data-smarty-status]')?.textContent).toBe('Idle· Last active now');
  await unmount();
});

test('phone width: each Smarty chip keeps its status whole and truncates the name instead', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('working', null, T) }, { id: 'kate', activity: act0('waiting') }]));
  useFeedStore.getState().selectSmarty('paul');
  const { host, unmount } = await mount(<FeedView compact services={services} />, 320);
  const chips = Array.from(host.querySelectorAll('[role="group"] button'));
  expect(chips.map(chip => chip.textContent)).toEqual(['Paul’s SmartyWorking', 'Kate’s SmartyWaiting']);
  for (const chip of chips) {
    expect(chip.className).toContain('min-w-0');
    expect(chip.querySelector('span.truncate')?.className).toContain('min-w-0');
    const badge = chip.querySelector('[data-smarty-status]')!;
    expect(badge.className).toContain('shrink-0');
    expect(badge.className).toContain('whitespace-nowrap');
    expect(badge.querySelector('[data-smarty-last-active]')).toBeNull(); // No time in a chip: it stays short.
  }
  expect(host.querySelector('[data-smarty-working]')?.textContent).toBe('Working…');
  await unmount();
});

test('the list parses the gateway\'s durations against the browser clock; a failed refresh marks each status unknown', async () => {
  const body = { me: 'paul', smarties: [{ id: 'paul', label: 'P', own: true, writable: true, activity: { state: 'working', workingForMs: 12_000, lastActiveAgoMs: 0 } },
    { id: 'kate', label: 'K', own: false, writable: false, activity: { state: 'surprising', workingForMs: null, lastActiveAgoMs: 60_000 } }] };
  jest.useFakeTimers({ now: T });
  const result = await loadSmarties(async () => Response.json(body));
  expect(result.state === 'ready' && result.smarties.map(s => s.activity)).toEqual([{ state: 'working', startedAt: T - 12_000, lastActiveAt: T },
    { state: 'unknown', startedAt: null, lastActiveAt: T - 60_000 }]);
  jest.useRealTimers();
  useFeedStore.getState().setSmarties(result);
  await refreshSmarties(async () => { throw new Error('down'); });
  const now = useFeedStore.getState().smarties;
  expect(now.state === 'ready' && now.smarties.map(s => s.activity?.state)).toEqual(['unknown', 'unknown']);
});

test('a refresh never overlaps itself: a second call while one is in flight shares it (no stale overwrite)', async () => {
  const smarty = { id: 'paul', label: 'P', own: true, writable: true, activity: { state: 'idle', startedAt: null, lastActiveAt: T } };
  useFeedStore.getState().setSmarties({ state: 'ready', me: 'paul', smarties: [smarty] } as never);
  let calls = 0, release!: () => void;
  const slow = () => { calls++; return new Promise<never>((_, reject) => { release = () => reject(new Error('late')); }); };
  const first = refreshSmarties(slow), second = refreshSmarties(slow);
  expect(second).toBe(first);
  expect(calls).toBe(1);
  release(); await first;
  await refreshSmarties(async () => { throw new Error('again'); });
  expect(calls).toBe(1);
});

test('a list refresh never overwrites a stream status that arrived while it was in flight', async () => {
  const idle = { state: 'idle' as const, startedAt: null, lastActiveAt: T };
  useFeedStore.getState().setSmarties({ state: 'ready', me: 'paul', smarties: [{ id: 'paul', label: 'P', own: true, writable: true, activity: idle },
    { id: 'kate', label: 'K', own: false, writable: false, activity: idle }] } as never);
  let answer!: (value: never) => void;
  const read = refreshSmarties(() => new Promise(resolve => { answer = resolve as never; }));
  const working = { state: 'working' as const, startedAt: T, lastActiveAt: T };
  useFeedStore.getState().setActivity('paul', working); // The open Smarty's stream, newer than the read's snapshot.
  answer({ state: 'ready', me: 'paul', smarties: [{ id: 'paul', label: 'P', own: true, writable: true, activity: idle },
    { id: 'kate', label: 'K', own: false, writable: false, activity: { state: 'waiting', startedAt: null, lastActiveAt: T } }] } as never);
  await read;
  const now = useFeedStore.getState().smarties;
  expect(now.state === 'ready' && now.smarties.map(s => s.activity?.state)).toEqual(['working', 'waiting']);
});

// smarty-code#1595: "Paul's Smarty is working…" at the bottom of the person's own feed while their Smarty takes a turn.
const typingLine = (host: Element) => host.querySelector('[data-smarty-typing]');
const working = () => ({ state: 'working' as const, startedAt: Date.now(), lastActiveAt: Date.now() });
const idle = () => ({ state: 'idle' as const, startedAt: null, lastActiveAt: Date.now() });

test('#1595: the own Smarty working shows "Paul\'s Smarty is working…" at the bottom of the feed; idle hides it', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('idle') }, { id: 'kate', activity: act0('idle') }]));
  useFeedStore.getState().selectSmarty('paul');
  const { host, unmount } = await mount(<FeedView services={services} />);
  // The row is held empty while idle, so the line never moves the feed when it comes.
  const row = host.querySelector('[role="status"].chat-message-column')!;
  expect(row.textContent).toBe('');
  expect(typingLine(host)).toBeNull();
  await act(async () => { onStatus!(working()); });
  expect(typingLine(host)).toBe(row);
  expect(row.querySelector('.sr-only')?.textContent).toBe("Paul's Smarty is working…");
  expect(row.querySelectorAll('.oc-typing-dots > span').length).toBe(3);
  // At the bottom: after the transcript, before the message box.
  const transcript = host.querySelector('ol[aria-label]')!.parentElement!, box = host.querySelector('form')!;
  expect(transcript.nextElementSibling).toBe(row);
  expect(row.nextElementSibling).toBe(box);
  await act(async () => { onStatus!(idle()); });
  expect(typingLine(host)).toBeNull();
  await unmount();
});

test('#1595: a new reply from the Smarty hides the line while its turn still runs', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('idle') }]));
  useFeedStore.getState().selectSmarty('paul');
  const { host, unmount } = await mount(<FeedView services={services} />);
  await act(async () => { onStatus!(working()); });
  expect(typingLine(host)).not.toBeNull();
  // The person's own line is not a reply: the line stays.
  await act(async () => { onBlocks!({ blocks: [{ id: 'p2', author: 'paul', at: '10:01 PM ET', text: 'And?' }], offset: 60 }); });
  expect(typingLine(host)).not.toBeNull();
  await act(async () => { onBlocks!({ blocks: [{ id: 'k2', author: 'org', at: '10:02 PM ET', text: 'Done.' }], offset: 80 }); });
  expect(typingLine(host)).toBeNull();
  // The next turn shows it again, even when its start and the last turn's end land in one render (a queued message).
  await act(async () => { onStatus!(idle()); onStatus!(working()); });
  expect(typingLine(host)).not.toBeNull();
  await act(async () => { onBlocks!({ blocks: [{ id: 'k4', author: 'org', at: '10:04 PM ET', text: 'Next.' }], offset: 100 }); });
  expect(typingLine(host)).toBeNull();
  await unmount();
});

test('#1595: another person\'s Smarty working shows no line', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('idle') }, { id: 'kate', activity: act0('working', T, T) }]));
  useFeedStore.getState().selectSmarty('kate');
  const { host, unmount } = await mount(<FeedView services={services} />);
  await act(async () => { onStatus!(working()); });
  expect(host.querySelector('[data-smarty-working]')).not.toBeNull(); // Kate's header status still shows.
  expect(typingLine(host)).toBeNull();
  expect(host.textContent).not.toContain('Smarty is working');
  await unmount();
});

test('#1595: the line adds no reads, streams or timers: it comes only from the stream\'s status', async () => {
  useFeedStore.getState().setSmarties(ready([{ id: 'paul', activity: act0('idle') }]));
  useFeedStore.getState().selectSmarty('paul');
  // Every network read and timer started from here on is counted.
  const calls = { fetch: 0, setInterval: 0, setTimeout: 0 };
  const real = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
  const counting = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => { calls.fetch++; return real.fetch(input, init); },
    setInterval: (handler: () => void, ms?: number): ReturnType<typeof setInterval> => { calls.setInterval++; return real.setInterval(handler, ms); },
    setTimeout: (handler: () => void, ms?: number): ReturnType<typeof setTimeout> => { calls.setTimeout++; return real.setTimeout(handler, ms); },
  };
  const { host, unmount } = await mount(<FeedView services={services} />);
  const before = { loads, streams };
  for (const key of ['fetch', 'setInterval', 'setTimeout'] as const) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: counting[key] });
  try {
    await act(async () => { onStatus!({ state: 'working', startedAt: null, lastActiveAt: Date.now() }); });
    expect(typingLine(host)).not.toBeNull();
    await act(async () => { onBlocks!({ blocks: [{ id: 'k3', author: 'org', at: '10:03 PM ET', text: 'Here.' }], offset: 90 }); });
    await act(async () => { onStatus!(idle()); });
    expect(typingLine(host)).toBeNull();
  } finally {
    for (const key of ['fetch', 'setInterval', 'setTimeout'] as const) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: real[key] });
  }
  expect(calls).toEqual({ fetch: 0, setInterval: 0, setTimeout: 0 });
  expect({ loads, streams }).toEqual(before);
  await unmount();
});
