import { describe, expect, mock, test } from 'bun:test';
import { actOnInboxItem, inboxItemState, loadInbox, sortInboxItems, useInboxStore, watchInbox, type InboxItem } from './smartyInbox';

const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'a', to: 'paul', title: 'T', actions: ['accept', 'respond', 'ignore'],
  links: [], priority: 'normal', created: '2026-09-28T10:00:00.000Z', updated: '2026-09-28T10:00:00.000Z', ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('smarty-code#701 inbox data', () => {
  test('a list that carries an id twice (a replayed or re-sent item) yields one item per id: the newest version, at its first place', async () => {
    const older = item({ id: 'dup', title: 'Old title', updated: '2026-10-07T09:00:00.000Z' });
    const newer = item({ id: 'dup', title: 'New title', updated: '2026-10-07T10:00:00.000Z' });
    const other = item({ id: 'other', created: '2026-09-27T00:00:00.000Z' });
    const result = await loadInbox('open', async () => json({ person: 'paul', items: [older, other, newer] }));
    expect(result.items.map(i => [i.id, i.title])).toEqual([['dup', 'New title'], ['other', 'T']]);
    const all = await loadInbox('all', async () => json({ person: 'paul', items: [newer, older, other] }));
    expect(all.items.map(i => [i.id, i.title])).toEqual([['dup', 'New title'], ['other', 'T']]);
  });
  test('P0 items first, then the newest', () => {
    const items = [item({ id: 'old' }), item({ id: 'p0', priority: 'p0', created: '2026-09-27T00:00:00.000Z' }),
      item({ id: 'new', created: '2026-09-28T12:00:00.000Z' })];
    expect(sortInboxItems(items).map(i => i.id)).toEqual(['p0', 'new', 'old']);
  });

  test('an item is resolved, snoozed (until later) or open', () => {
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    expect(inboxItemState(item({ resolved: { at: '2026-09-28T11:00:00.000Z', by: 'paul' } }), now)).toBe('resolved');
    expect(inboxItemState(item({ snoozedUntil: '2026-09-28T13:00:00.000Z' }), now)).toBe('snoozed');
    expect(inboxItemState(item({ snoozedUntil: '2026-09-28T11:00:00.000Z' }), now)).toBe('open');
  });

  test('a 403 is "no inbox" (no badge); other failures are errors', async () => {
    const fetcher = mock(async () => json({ data: { message: 'This account has no inbox' } }, 403));
    expect(await loadInbox('open', fetcher)).toEqual({ available: false, items: [] });
    await expect(loadInbox('open', async () => json({ data: { message: 'Inbox command failed: x' } }, 502))).rejects.toThrow('Inbox command failed: x');
  });

  test('loads the list, drops malformed items and sorts it', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => { urls.push(url); return json({ person: 'paul', items: [item({ id: 'x' }), { id: 'bad' }, item({ id: 'p', priority: 'p0' })] }); };
    const result = await loadInbox('open', fetcher);
    expect(urls).toEqual(['/api/inbox?state=open']);
    expect([result.available, ...result.items.map(i => i.id)]).toEqual([true, 'p', 'x']);
  });

  test('an action posts only the documented body to the encoded id; the error message is kept (413)', async () => {
    const calls: [string, RequestInit][] = [];
    const ok = async (url: string, init: RequestInit) => { calls.push([url, init]); return json({ person: 'paul', item: item({ id: 'ask:1' }) }); };
    await actOnInboxItem('ask:1', 'resolve', { action: 'accept' }, ok);
    expect(calls[0]![0]).toBe('/api/inbox/ask%3A1/resolve');
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ action: 'accept' });
    await actOnInboxItem('ask:1', 'reopen', {}, ok);
    expect(calls[1]![0]).toBe('/api/inbox/ask%3A1/reopen');
    await expect(actOnInboxItem('a', 'answer', { text: 'x', action: 'respond' },
      async () => json({ data: { message: 'Answer text is too long for the inbox (at most 3500 bytes); nothing was sent' } }, 413)))
      .rejects.toThrow('too long');
  });

  test('the badge counts open items and the P0 among them', () => {
    useInboxStore.getState().setOpenItems(true, [item({ id: 'a' }), item({ id: 'b', priority: 'p0' })]);
    expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 2, p0Count: 1 });
    useInboxStore.getState().setOpenItems(false, []);
    expect(useInboxStore.getState()).toMatchObject({ available: false, openCount: 0 });
  });
});

describe('#365 review: the badge survives a transient failure', () => {
  test('a failed first load is retried until it answers; then the badge shows', async () => {
    useInboxStore.getState().setOpenItems(false, []);
    let calls = 0;
    const load = async () => { calls += 1; if (calls < 3) throw new Error('gateway restarting'); return { available: true, items: [item({ id: 'a' })] }; };
    const stop = watchInbox(load, [5, 5, 5]);
    for (let i = 0; i < 100 && !useInboxStore.getState().available; i++) await new Promise(r => setTimeout(r, 5));
    stop();
    expect(calls).toBe(3);
    expect(useInboxStore.getState()).toMatchObject({ available: true, openCount: 1 });
  });

  test('a 403 (no inbox) is an answer: no retry', async () => {
    let calls = 0;
    const stop = watchInbox(async () => { calls += 1; return { available: false, items: [] }; }, [5]);
    await new Promise(r => setTimeout(r, 40)); stop();
    expect(calls).toBe(1);
  });
});
