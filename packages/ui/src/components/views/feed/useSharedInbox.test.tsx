import { afterAll, afterEach, beforeEach, expect, jest, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useSharedInbox, type SharedInbox } from './useSharedInbox';

// Review of openchamber#574 (smarty-code#1476): the shared inbox belongs to one viewer, and a transient failure recovers on
// the mounted page while a refusal stays hidden without retrying.
const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement, Element: win.Element };
const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const realFetch = globalThis.fetch;
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

const item = (id: string) => ({ id, to: 'kate', title: id, actions: [], links: [], priority: 'normal', created: '2026-10-07T04:00:00.000Z', updated: '2026-10-07T04:00:00.000Z' });
const answer = (count: number, status = 200) => new Response(JSON.stringify(status === 200 ? { person: 'kate', items: Array.from({ length: count }, (_, n) => item(`k${n}`)) } : { data: { message: 'no' } }),
  { status, headers: { 'content-type': 'application/json' } });
let replies: (() => Promise<Response>)[] = [];
let reads = 0;
let watched = 0;
let changed: () => void = () => undefined;
const watch = (_person: string, onChange: () => void) => { watched += 1; changed = onChange; return () => undefined; };
let seen: SharedInbox = { state: 'hidden' };
const Probe = () => { seen = useSharedInbox('kate', watch); return null; };
// Lets the stubbed fetch, its JSON and the hook's handlers run (microtasks only; timers are fake).
const flush = () => act(async () => { for (let n = 0; n < 50; n += 1) await Promise.resolve(); });
const deferred = () => { let resolve: (r: Response) => void = () => undefined; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  jest.useFakeTimers();
  replies = []; reads = 0; watched = 0; seen = { state: 'hidden' };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url: string) => {
    // Only inbox reads count; a 401 also sends the app's one /auth/session check.
    if (!String(url).includes('/api/inbox')) return new Response('{}', { status: 200 });
    const next = replies[reads] ?? replies.at(-1)!; reads += 1; return next();
  } });
});
afterEach(() => { jest.useRealTimers(); Object.defineProperty(globalThis, 'fetch', { configurable: true, value: realFetch }); });
const mount = async () => {
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />)); await flush();
  return () => act(async () => root.unmount());
};

test('a new viewer on the same page never sees the old viewer’s shared inbox, nor an answer to the old viewer’s read', async () => {
  const late = deferred(), fresh = deferred();
  replies = [async () => answer(1), () => late.promise, () => fresh.promise];
  const unmount = await mount();
  expect(seen).toMatchObject({ state: 'shown', openCount: 1 });
  // The old viewer's stream asks for a reread that is still in flight when another person signs in.
  await act(async () => { changed(); }); await flush();
  await act(async () => { useAuthSessionStore.getState().markAuthenticated(); });
  expect(seen).toEqual({ state: 'hidden' });
  await flush();
  expect(reads).toBe(3);
  await act(async () => { late.resolve(answer(5)); }); await flush();
  expect(seen).toEqual({ state: 'hidden' });
  await act(async () => { fresh.resolve(answer(2)); }); await flush();
  expect(seen).toMatchObject({ state: 'shown', openCount: 2, revision: 0 });
  await unmount();
});

test('a transient failure retries on the mounted page, and the inbox and its stream start once a read succeeds', async () => {
  replies = [async () => { throw new TypeError('network down'); }, async () => answer(0, 503), async () => answer(0, 429), async () => answer(1)];
  const unmount = await mount();
  expect([seen.state, reads, watched]).toEqual(['hidden', 1, 0]);
  for (const [wait, expected] of [[2_000, 2], [5_000, 3], [15_000, 4]] as const) {
    await act(async () => { jest.advanceTimersByTime(wait - 1); }); await flush();
    expect(reads).toBe(expected - 1);
    await act(async () => { jest.advanceTimersByTime(1); }); await flush();
    expect(reads).toBe(expected);
  }
  expect(seen).toMatchObject({ state: 'shown', openCount: 1 });
  expect(watched).toBe(1);
  await unmount();
});

test('a refusal (403, 401, 404) stays hidden and is not retried', async () => {
  for (const status of [403, 401, 404]) {
    replies = [async () => answer(0, status)]; reads = 0;
    const unmount = await mount();
    await act(async () => { jest.advanceTimersByTime(10 * 60_000); }); await flush();
    expect([status, seen.state, reads, watched]).toEqual([status, 'hidden', 1, 0]);
    await unmount();
  }
});

test('after the first retries it retries every 30 s, and not while the page is hidden', async () => {
  replies = [async () => answer(0, 502)];
  const unmount = await mount();
  for (const wait of [2_000, 5_000, 15_000, 30_000, 30_000]) { await act(async () => { jest.advanceTimersByTime(wait); }); await flush(); }
  expect(reads).toBe(6);
  const visibility = (state: string) => Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => state });
  visibility('hidden');
  await act(async () => { jest.advanceTimersByTime(5 * 30_000); }); await flush();
  expect(reads).toBe(6);
  visibility('visible');
  await act(async () => { win.document.dispatchEvent(new win.Event('visibilitychange')); }); await flush();
  expect(reads).toBe(7);
  Reflect.deleteProperty(win.document, 'visibilityState');
  await unmount();
});

test('a tab brought back hides the shared inbox in that same render and shows it again only on the current cookie\'s read', async () => {
  const again = deferred();
  replies = [async () => answer(2), () => again.promise];
  const unmount = await mount();
  expect(seen).toMatchObject({ state: 'shown', openCount: 2 });
  // Another person may have signed in from another tab while this one was away: nothing shows until the gateway answers.
  await act(async () => { win.document.dispatchEvent(new win.Event('visibilitychange')); });
  expect(seen).toEqual({ state: 'hidden' });
  expect(reads).toBe(2);
  again.resolve(answer(0, 403)); await flush();
  expect(seen).toEqual({ state: 'hidden' }); // The new cookie is not shared this inbox: it stays hidden.
  await unmount();
});
