import { afterAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useInboxStore, type InboxItem } from '@/lib/smartyInbox';

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLButtonElement: win.HTMLButtonElement, KeyboardEvent: win.KeyboardEvent, Event: win.Event, CustomEvent: win.CustomEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win), MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { StepsLayout } = await import('./StepsLayout');

// Controlled clock. Long waits (the snooze wakeup) are held here; short ones (React, happy-dom) stay real.
// A held delay above 2^31−1 ms fires after 1 ms, as browsers and Node do.
const MAX_DELAY = 2 ** 31 - 1;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realNow = Date.now;
let clock = Date.parse('2026-10-10T00:00:00.000Z');
let nextId = 1;
const held = new Map<ReturnType<typeof setTimeout> | number, { due: number; run: () => void }>();
const requested: number[] = [];
const fakeSetTimeout = (run: () => void, delay = 0) => {
  if (delay < 1000) return realSetTimeout(run, delay);
  requested.push(delay);
  const id = nextId++;
  held.set(id, { due: clock + (delay > MAX_DELAY ? 1 : delay), run });
  return id;
};
const fakeClearTimeout = (id: ReturnType<typeof setTimeout> | number | undefined) => {
  if (id !== undefined && !held.delete(id)) realClearTimeout(id);
};
Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: fakeSetTimeout });
Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: fakeClearTimeout });
Date.now = () => clock;
afterAll(async () => {
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: realSetTimeout });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: realClearTimeout });
  Date.now = realNow;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
/** Move the clock to `at`, firing every held timer due by then in due order (including ones rearmed on the way). */
const advanceTo = (at: number) => act(async () => {
  for (;;) {
    const due = [...held].filter(([, t]) => t.due <= at).sort((a, b) => a[1].due - b[1].due)[0];
    if (!due) break;
    held.delete(due[0]); clock = Math.max(clock, due[1].due); due[1].run();
  }
  clock = at;
});

const item = (over: Partial<InboxItem> = {}): InboxItem => ({ id: 'step:a:1', to: 'paul', title: 'Release — Run the check',
  actions: ['respond'], source: 'steps:v1:a:01/01', recommendation: 'bun test', links: [],
  priority: 'normal', created: 'v0', updated: 'v1', ...over });

test('a snooze longer than the timer limit keeps Done disabled until the real expiry, then enables it without a request', async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return new Response('{}'); };
  const start = clock;
  const until = start + MAX_DELAY + 3 * 24 * 60 * 60 * 1000;
  useInboxStore.getState().setItems(true, []);
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const done = () => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Mark step'))!;
  try {
    await act(async () => root.render(<I18nProvider><StepsLayout><div /></StepsLayout></I18nProvider>));
    await act(async () => {
      useInboxStore.getState().setItems(true, [item({ snoozedUntil: new Date(until).toISOString() })], { capabilities: { guardedReopen: true } });
    });
    expect(done().disabled).toBe(true);
    for (const at of [start + 1, start + MAX_DELAY, start + MAX_DELAY + 1, until - 1]) {
      await advanceTo(at);
      expect(done().disabled).toBe(true);
    }
    await advanceTo(until + 1);
    expect(done().disabled).toBe(false);
    expect(requests).toBe(0);
    expect(requested.every(delay => delay <= MAX_DELAY)).toBe(true);
    expect(held.size).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount()); host.remove();
  }
});
