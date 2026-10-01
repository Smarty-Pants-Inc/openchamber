import { afterAll, expect, test } from 'bun:test';
import { groupInboxSteps } from './inboxSteps';
import { loadInbox, refreshInboxBadge, useInboxStore, watchInbox, type InboxItem } from './smartyInbox';

const item: InboxItem = { id: 'step:a', to: 'paul', title: 'A — instruction', source: 'steps:v1:a:01/01',
  actions: ['respond'], recommendation: 'raw', links: [], priority: 'normal', created: 'v0', updated: 'v1' };
const originalFetch = globalThis.fetch;
const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (eventSourceDescriptor) Object.defineProperty(globalThis, 'EventSource', eventSourceDescriptor);
  else Reflect.deleteProperty(globalThis, 'EventSource');
});
const json = (items: object[], guardedReopen = false) => new Response(JSON.stringify({ person: 'paul', items,
  capabilities: { guardedReopen } }), { headers: { 'content-type': 'application/json' } });

test('all-state parsing poisons only the malformed member’s claimed group, retaining unrelated valid lists', async () => {
  const unrelated = { ...item, id: 'step:b', title: 'B — instruction', source: 'steps:v1:b:01/01' };
  const result = await loadInbox('all', async () => json([item, { source: 'steps:v1:a:01/01', to: 'paul', title: 123 }, unrelated]));
  expect(result.items.map(i => i.id)).toEqual(['step:a', 'step:b']);
  expect(groupInboxSteps(result.items, result.invalidStepGroups).map(g => g.id)).toEqual(['b']);
  expect(result.capabilities).toEqual({ guardedReopen: false });
  const foreign = await loadInbox('all', async () => json([{ ...item, to: 'other' }]));
  expect(groupInboxSteps(foreign.items, foreign.invalidStepGroups)).toEqual([]);
});

test('guarded reopen capability is explicit; omitted capability fails closed', async () => {
  expect((await loadInbox('all', async () => json([item], true))).capabilities).toEqual({ guardedReopen: true });
  expect((await loadInbox('all', async () => new Response(JSON.stringify({ person: 'paul', items: [item] })))).capabilities)
    .toEqual({ guardedReopen: false });
});

test('one all-state GET per existing SSE event, completed records retained and open badge excludes them', async () => {
  const sources: BadgeSource[] = [];
  class BadgeSource {
    onmessage: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) { sources.push(this); }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: BadgeSource });
  const urls: string[] = [];
  const done = { ...item, resolved: { at: 'v2', by: 'paul', action: 'respond' } };
  globalThis.fetch = async input => { urls.push(String(input)); return json([done]); };
  const stop = watchInbox();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(urls).toEqual(['/api/inbox?state=all']); expect(sources).toHaveLength(1);
  expect(useInboxStore.getState().items).toHaveLength(1); expect(useInboxStore.getState().openCount).toBe(0);
  sources[0]?.onmessage?.(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(urls).toEqual(['/api/inbox?state=all', '/api/inbox?state=all']); expect(sources).toHaveLength(1);
  stop(); expect(sources[0]?.closed).toBe(true);
});

test('a delayed refresh cannot overwrite a stored mutation; failed refresh preserves records without granting group authority', async () => {
  useInboxStore.getState().setItems(true, [item]);
  let release!: (response: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const refresh = refreshInboxBadge();
  await new Promise(resolve => setTimeout(resolve, 10));
  const updated = { ...item, updated: 'v2' }; useInboxStore.getState().recordItem(updated);
  release(json([item])); await refresh;
  expect(useInboxStore.getState().items).toEqual([updated]);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await refreshInboxBadge();
  expect(useInboxStore.getState().items).toEqual([updated]); expect(useInboxStore.getState().snapshotValid).toBe(false);
});

test('out-of-order snapshots cannot resurrect an older command under the same recipient/list', async () => {
  useInboxStore.getState().setItems(true, [item]);
  const receipts: ((response: Response) => void)[] = [];
  globalThis.fetch = () => new Promise(resolve => { receipts.push(resolve); });
  const older = refreshInboxBadge(); await new Promise(resolve => setTimeout(resolve, 10));
  const newer = refreshInboxBadge(); await new Promise(resolve => setTimeout(resolve, 10));
  const updated = { ...item, updated: 'v2', recommendation: 'new command' };
  receipts[1]!(json([updated])); await newer;
  receipts[0]!(json([item])); await older;
  expect(useInboxStore.getState().items).toEqual([updated]);
});
