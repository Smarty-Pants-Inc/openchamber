import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { refreshInboxBadge, useInboxStore, watchInbox, type InboxItem } from './smartyInbox';
import { switchRuntimeEndpoint } from './runtime-switch';

const item: InboxItem = { id: 'step:a', to: 'paul', title: 'A — instruction', source: 'steps:v1:a:01/01',
  actions: ['respond'], links: [], priority: 'p0', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' };
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
const json = (items: InboxItem[]) => Response.json({ person: 'paul', items, capabilities: { guardedReopen: true } });
// Astra's isolated counterexample: 2,600 historical items with 3 KB recommendations exceed the gateway's 8 MiB stdout cap.
const history = Array.from({ length: 2600 }, (_, n) => ({ ...item, id: `history:${n}`, recommendation: 'x'.repeat(3000), resolved: { at: item.updated } }));
const overflow = () => Response.json({ data: { message: 'stdout maxBuffer length exceeded' } }, { status: 502 });
const fetchInbox = (fetcher: typeof fetch) => { globalThis.fetch = (input, init) => String(input).endsWith('/auth/url-token')
  ? Promise.resolve(Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 })) : fetcher(input, init); };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
let stop = () => {};
afterEach(() => { stop(); stop = () => {}; sources.length = 0; globalThis.fetch = originalFetch; });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

test('large all-history failure at bootstrap uses open 200, keeps the badge and starts the existing EventSource without Steps authority', async () => {
  expect(JSON.stringify(history).length).toBeGreaterThan(8 << 20);
  const urls: string[] = [];
  fetchInbox(async input => { const url = String(input); urls.push(url); return url.includes('state=all') ? overflow() : json([item]); });
  stop = watchInbox(); await settle();
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=open']);
  expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 1, p0Count: 1, snapshotValid: false, items: [] });
  expect(sources).toHaveLength(1); expect(sources[0]?.closed).toBe(false);
  sources[0]?.onmessage?.(); await settle();
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=open', '/api/inbox?state=all', '/api/inbox?state=open']);
  expect(sources).toHaveLength(1);
});

test('large all-history failure on SSE preserves existing records and EventSource, updates open badge and revokes Steps authority', async () => {
  let large = false;
  const urls: string[] = [];
  const historical = { ...item, id: 'done', priority: 'normal', resolved: { at: item.updated } };
  fetchInbox(async input => {
    const url = String(input); urls.push(url);
    return url.includes('state=all') ? large ? overflow() : json([historical]) : json([item]);
  });
  stop = watchInbox(); await settle();
  expect(useInboxStore.getState().snapshotValid).toBe(true);
  large = true; sources[0]?.onmessage?.(); await settle();
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=all', '/api/inbox?state=open']);
  expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 1, p0Count: 1, snapshotValid: false, items: [historical] });
  expect(sources).toHaveLength(1); expect(sources[0]?.closed).toBe(false);
  useInboxStore.getState().recordItem({ ...historical, updated: '2026-10-01T10:02:00.000Z' });
  expect(useInboxStore.getState()).toMatchObject({ openCount: 1, p0Count: 1, snapshotValid: false });
});

for (const phase of ['bootstrap', 'SSE']) test(`legacy 403 on ${phase} is no inbox, with no fallback or retry`, async () => {
  const urls: string[] = [];
  let unavailable = phase === 'bootstrap';
  fetchInbox(async input => { urls.push(String(input)); return unavailable ? new Response(null, { status: 403 }) : json([item]); });
  stop = watchInbox(undefined, [5]); await settle();
  if (phase === 'SSE') { unavailable = true; sources[0]?.onmessage?.(); await settle(); }
  expect(urls).toEqual(phase === 'bootstrap' ? ['/api/inbox?state=all'] : ['/api/inbox?state=all', '/api/inbox?state=all']);
  expect(useInboxStore.getState()).toMatchObject({ available: false, openCount: 0, snapshotValid: false });
  expect(sources).toHaveLength(phase === 'bootstrap' ? 0 : 1);
});

test('open fallback 403 is also no inbox and does not start a watcher', async () => {
  const urls: string[] = [];
  fetchInbox(async input => { urls.push(String(input)); return String(input).includes('state=all') ? overflow() : new Response(null, { status: 403 }); });
  stop = watchInbox(undefined, [5]); await settle();
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=open']);
  expect(useInboxStore.getState()).toMatchObject({ available: false, openCount: 0, snapshotValid: false });
  expect(sources).toHaveLength(0);
});

for (const phase of ['bootstrap', 'refresh']) test(`${phase} fallback cannot overwrite a newer mutation revision`, async () => {
  let release!: (response: Response) => void;
  const urls: string[] = [];
  fetchInbox(async input => { urls.push(String(input)); return String(input).includes('state=all') ? overflow() : new Promise(resolve => { release = resolve; }); });
  useInboxStore.getState().setItems(true, [item]);
  const pending = phase === 'refresh' ? refreshInboxBadge() : undefined;
  if (phase === 'bootstrap') stop = watchInbox();
  await settle();
  const newer = { ...item, updated: '2026-10-01T10:02:00.000Z', resolved: { at: '2026-10-01T10:02:00.000Z' } };
  useInboxStore.getState().setItems(true, [newer]);
  expect(urls).toHaveLength(2);
  release(json([item])); await pending; await settle();
  expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 0, snapshotValid: true, items: [newer] });
});

for (const held of ['all', 'open']) test(`runtime switch while ${held} is held rejects the old fallback and keeps one current watcher`, async () => {
  let release!: (response: Response) => void;
  const urls: string[] = [];
  let switched = false;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/url-token')) return Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 });
    urls.push(url);
    if (switched) return json([{ ...item, id: 'new-runtime' }]);
    if (held === 'all' || url.includes('state=open')) return new Promise(resolve => { release = resolve; });
    return overflow();
  };
  stop = watchInbox(); await settle();
  switched = true;
  switchRuntimeEndpoint({ apiBaseUrl: `https://${held}.example`, runtimeKey: `inbox-${held}` });
  await settle();
  release(held === 'all' ? overflow() : json([item])); await settle();
  expect(useInboxStore.getState().items.map(i => i.id)).toEqual(['new-runtime']);
  expect(useInboxStore.getState().snapshotValid).toBe(true);
  expect(sources.filter(source => !source.closed)).toHaveLength(1);
  expect(urls.filter(url => url.includes('state=open'))).toHaveLength(held === 'open' ? 1 : 0);
});
