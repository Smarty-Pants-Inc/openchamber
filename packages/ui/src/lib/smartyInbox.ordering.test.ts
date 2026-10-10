import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { refreshInboxBadge, useInboxStore, watchInbox, type InboxItem } from './smartyInbox';

// A no-inbox fallback retires retained Steps state. Bootstrap and refresh publication share one generation.
const step = (id: string, list: string): InboxItem => ({ id, to: 'paul', title: `${list} — instruction`, source: `steps:v1:${list}:01/01`,
  actions: ['respond'], links: [], priority: 'normal', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' });
const a = step('step:a', 'a'), b = step('step:b', 'b'), c = step('step:c', 'c');
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

const holdBootstrap = (items: InboxItem[]) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = async () => { await gate; return { available: true, items, capabilities: { guardedReopen: true }, invalidStepGroups: [] }; };
  return { load, release };
};

test('held bootstrap succeeds after a newer refresh starts: it survives that refresh and the next both failing all and open', async () => {
  const held = holdBootstrap([a, b]);
  const pending: ((response: Response) => void)[] = [], urls: string[] = [];
  fetchInbox(url => { urls.push(url); return new Promise(resolve => { pending.push(resolve); }); });
  stop = watchInbox(held.load); await settle();
  const first = refreshInboxBadge(); await settle();
  held.release(); await settle();
  pending[0]!(overflow()); await settle();
  pending[1]!(overflow()); await first; await settle();
  const retained = { available: true, items: [a, b], openCount: 2, p0Count: 0, snapshotValid: false };
  expect(useInboxStore.getState()).toMatchObject(retained);
  const second = refreshInboxBadge(); await settle();
  pending[2]!(overflow()); await settle();
  pending[3]!(overflow()); await second; await settle();
  expect(useInboxStore.getState()).toMatchObject(retained);
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=open', '/api/inbox?state=all', '/api/inbox?state=open']);
  expect(sources).toHaveLength(1);
});

test('counterexample: a newer successful refresh replaces the bootstrap (overlap, then genuinely empty); a receipt still fences a stale read', async () => {
  const held = holdBootstrap([a, b]);
  const pending: ((response: Response) => void)[] = [];
  fetchInbox(() => new Promise(resolve => { pending.push(resolve); }));
  stop = watchInbox(held.load); await settle();
  const overlap = refreshInboxBadge(); await settle();
  held.release(); await settle();
  pending[0]!(json([b, c])); await overlap; await settle();
  expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, items: [b, c], openCount: 2 });
  const stale = refreshInboxBadge(); await settle();
  const receipt = { ...c, updated: '2026-10-01T11:00:00.000Z', resolved: { at: '2026-10-01T11:00:00.000Z' } };
  useInboxStore.getState().recordItem(receipt);
  pending[1]!(json([])); await stale; await settle();
  expect(useInboxStore.getState()).toMatchObject({ items: [b, receipt], openCount: 1, snapshotValid: false });
  const empty = refreshInboxBadge(); await settle();
  pending[2]!(json([])); await empty; await settle();
  expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, items: [], openCount: 0, p0Count: 0 });
});

test('bootstrap held, newer refreshes A then A+B: bootstrap success shows until B succeeds; older A completing after B publishes nothing', async () => {
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
    expect(events).toBe(1); // A successful snapshot publishes until a newer read succeeds.
    expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, guardedReopen: false, items: [a] });
    expect(sources).toHaveLength(1); // One existing subscription.
    releases[1]!(json([a, b, malformed])); await refreshB; await settle();
    expect(events).toBe(2);
    releases[0]!(json([a])); await refreshA; await settle();
    expect(events).toBe(2);
    expect(useInboxStore.getState()).toMatchObject({ available: true, snapshotValid: true, guardedReopen: true, items: [a, b], revision: start + 2 });
    expect(useInboxStore.getState().invalidStepGroups).toEqual([JSON.stringify(['paul', 'broken'])]);
  } finally { unsubscribe(); }
});
