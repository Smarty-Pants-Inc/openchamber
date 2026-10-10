import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { refreshInboxBadge, useInboxStore, watchInbox, type InboxItem } from './smartyInbox';

// A no-inbox fallback retires retained Steps state. Bootstrap and refresh publication share one generation.
const step = (id: string, list: string): InboxItem => ({ id, to: 'paul', title: `${list} — instruction`, source: `steps:v1:${list}:01/01`,
  actions: ['respond'], links: [], priority: 'normal', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' });
const a = step('step:a', 'a'), b = step('step:b', 'b');
const malformed = { id: 'step:bad', to: 'paul', source: 'steps:v1:broken:01/01' };
const originalFetch = globalThis.fetch;
const win = new Window({ url: 'https://inbox.example' });
const previous = new Map(['window', 'CustomEvent', 'EventSource'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const sources: InboxSource[] = [];
class InboxSource {
  onmessage: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { sources.push(this); }
  close() { this.closed = true; }
}
Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: win.CustomEvent });
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: InboxSource });
const json = (items: (InboxItem | typeof malformed)[]) => Response.json({ person: 'paul', items, capabilities: { guardedReopen: true } });
const overflow = () => Response.json({ data: { message: 'stdout maxBuffer length exceeded' } }, { status: 502 });
const fetchInbox = (fetcher: (url: string) => Promise<Response>) => { globalThis.fetch = input => String(input).endsWith('/auth/url-token')
  ? Promise.resolve(Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 })) : fetcher(String(input)); };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
let stop = () => {};
afterEach(() => { stop(); stop = () => {}; sources.length = 0; globalThis.fetch = originalFetch; });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

for (const phase of ['SSE', 'action refresh']) test(`${phase}: all fails then open fallback 403 retires retained Steps items, blockers and guarded reopen`, async () => {
  let failing = false;
  const urls: string[] = [];
  fetchInbox(async url => {
    urls.push(url);
    if (!failing) return json([a, malformed]);
    return url.includes('state=all') ? overflow() : new Response(null, { status: 403 });
  });
  stop = watchInbox(); await settle();
  expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, guardedReopen: true, items: [a] });
  expect(useInboxStore.getState().invalidStepGroups).toHaveLength(1);
  failing = true;
  if (phase === 'SSE') sources[0]?.onmessage?.(); else await refreshInboxBadge();
  await settle();
  expect(urls.slice(1)).toEqual(['/api/inbox?state=all', '/api/inbox?state=open']);
  expect(useInboxStore.getState()).toMatchObject({ available: false, openCount: 0, p0Count: 0, snapshotValid: false,
    guardedReopen: false, invalidStepGroups: [], items: [] });
});

test('counterexample: transient history failure with open 200 keeps retained history, but not actionable', async () => {
  let failing = false;
  fetchInbox(async url => failing && url.includes('state=all') ? overflow() : json([a, malformed]));
  stop = watchInbox(); await settle();
  failing = true; sources[0]?.onmessage?.(); await settle();
  expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 1, snapshotValid: false, items: [a] });
});

test('bootstrap held, newer refreshes A then A+B: older completions publish nothing; newest snapshot with B and malformed blockers wins', async () => {
  let releaseBootstrap!: () => void;
  const bootstrap = new Promise<void>(resolve => { releaseBootstrap = resolve; });
  const releases: ((response: Response) => void)[] = [];
  fetchInbox(() => new Promise(resolve => { releases.push(resolve); }));
  stop = watchInbox(async () => { await bootstrap; return { available: true, items: [a], capabilities: { guardedReopen: false }, invalidStepGroups: [] }; });
  await settle();
  const refreshA = refreshInboxBadge(), refreshB = refreshInboxBadge();
  await settle();
  expect(releases).toHaveLength(2);
  const start = useInboxStore.getState().revision;
  let events = 0;
  const unsubscribe = useInboxStore.subscribe(() => { events += 1; });
  try {
    releaseBootstrap(); await settle();
    expect(events).toBe(0);
    expect(sources).toHaveLength(1); // The superseded bootstrap still opens the one existing subscription.
    releases[0]!(json([a])); await refreshA; await settle();
    expect(events).toBe(0);
    releases[1]!(json([a, b, malformed])); await refreshB; await settle();
    expect(events).toBe(1);
    expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, guardedReopen: true, items: [a, b], revision: start + 1 });
    expect(useInboxStore.getState().invalidStepGroups).toEqual([JSON.stringify(['paul', 'broken'])]);
  } finally { unsubscribe(); }
});
