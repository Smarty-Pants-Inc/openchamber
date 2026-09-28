import { describe, expect, mock, test } from 'bun:test';
import { actOnInboxItem, inboxItemState, loadInbox, sortInboxItems, useInboxStore, type InboxItem } from './smartyInbox';

const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'a', to: 'paul', title: 'T', actions: ['accept', 'respond', 'ignore'],
  links: [], priority: 'normal', created: '2026-09-28T10:00:00.000Z', updated: '2026-09-28T10:00:00.000Z', ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('smarty-code#701 inbox data', () => {
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
    await expect(loadInbox('open', fetcher)).resolves.toEqual({ available: false, items: [] });
    await expect(loadInbox('open', async () => json({ data: { message: 'Inbox command failed: x' } }, 502))).rejects.toThrow('Inbox command failed: x');
  });

  test('loads the list, drops malformed items and sorts it', async () => {
    const fetcher = mock(async () => json({ person: 'paul', items: [item({ id: 'x' }), { id: 'bad' }, item({ id: 'p', priority: 'p0' })] }));
    const result = await loadInbox('open', fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/inbox?state=open', expect.anything());
    expect(result).toEqual({ available: true, items: [expect.objectContaining({ id: 'p' }), expect.objectContaining({ id: 'x' })] });
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
