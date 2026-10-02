import { expect, test } from 'bun:test';
import { act } from 'react';
import { toast } from 'sonner';
import { isStepDone } from '@/lib/inboxSteps';
import { ordinary, gateway, posts, reads, mount, click, typeReply, snooze, undo, button, settle,
  useInboxStore, unavailableCrypto, remount } from './InboxView.guards.fixture';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = new Set<string>();
function keyedBody(body: typeof posts[number]['body'], expected: Omit<typeof body, 'opKey'>) {
  expect(body).toEqual({ ...expected, opKey: body.opKey });
  expect(uuid.test(body.opKey ?? '')).toBe(true);
  expect(keys.has(body.opKey!)).toBe(false);
  keys.add(body.opKey!);
}
const cases = [
  { label: 'Respond', endpoint: 'answer', body: { text: 'Typed answer retained', action: 'respond' } },
  { label: 'Edit', endpoint: 'answer', body: { text: 'Typed answer retained', action: 'edit' } },
  { label: 'Accept', endpoint: 'resolve', body: { action: 'accept' } },
  { label: 'Ignore', endpoint: 'resolve', body: { action: 'ignore' } },
  { label: '1 hour', endpoint: 'snooze', body: { for: '1h' } },
  { label: '4 hours', endpoint: 'snooze', body: { for: '4h' } },
  { label: '1 day', endpoint: 'snooze', body: { for: '1d' } },
  { label: '1 week', endpoint: 'snooze', body: { for: '1w' } },
  { label: 'Reopen', endpoint: 'reopen', body: {} },
] as const;
type Case = typeof cases[number];
const itemFor = (action: Case) => action.endpoint === 'reopen' ? { ...ordinary, resolved: { at: ordinary.updated, by: ordinary.to } } : ordinary;
async function perform(host: HTMLElement, action: Case) {
  if (action.endpoint === 'answer') { await typeReply(host, action.label); await click(host, 'Send'); }
  else if (action.endpoint === 'snooze') await snooze(host, action.label);
  else await click(host, action.label);
}
for (const action of cases) test(`ordinary ${action.label} sends exactly the shown version, never a hidden newer server version`, async () => {
  const item = itemFor(action), host = await mount(item);
  gateway.server = { ...item, updated: '2026-10-01T10:08:00.000Z' };
  const itemReads = reads.filter(url => url === '/api/inbox/ordinary%3Aa').length;
  await perform(host, action);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe(`/api/inbox/ordinary%3Aa/${action.endpoint}`);
  const body = { ...action.body, updated: item.updated };
  if (action.endpoint === 'answer' || action.endpoint === 'reopen') keyedBody(posts[0]!.body, body);
  else expect(posts[0]!.body).toEqual(body);
  expect(reads.filter(url => url === '/api/inbox/ordinary%3Aa')).toHaveLength(itemReads);
  if (action.endpoint === 'answer') {
    expect(host.querySelector('textarea')).toBeNull();
    expect(isStepDone(gateway.ack)).toBe(false);
    expect(host.textContent).not.toContain('Step marked done');
  }
  if (action.endpoint === 'resolve' || action.endpoint === 'snooze') {
    const ack = gateway.ack;
    expect(ack.id).toBe(item.id); expect(ack.to).toBe(item.to); expect(ack.updated).not.toBe(item.updated);
    await undo();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.url).toBe('/api/inbox/ordinary%3Aa/reopen');
    keyedBody(posts[1]!.body, { updated: ack.updated });
  }
});

for (const status of [403, 409]) for (const action of cases) test(`ordinary ${action.label} ${status} shows the reason without success or automatic retry`, async () => {
  const host = await mount(itemFor(action)); gateway.status = status;
  const before = toast.getHistory().length;
  await perform(host, action);
  expect(posts).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(gateway.reason);
  expect(toast.getHistory()).toHaveLength(before);
  expect(reads.filter(url => url === '/api/inbox/ordinary%3Aa')).toHaveLength(0);
  if (action.endpoint === 'answer') {
    expect(host.querySelector('textarea')?.value).toBe('Typed answer retained');
    expect(button(host, 'Send').disabled).toBe(false);
  }
  await settle(); expect(posts).toHaveLength(1);
});

for (const label of ['Respond', 'Edit', 'Reopen']) test(`ordinary ${label} missing native crypto refuses before any write`, async () => {
  const action = cases.find(action => action.label === label)!;
  const host = await mount(itemFor(action)); unavailableCrypto();
  await perform(host, action);
  expect(posts).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Unavailable');
  if (action.endpoint === 'answer') expect(host.querySelector('textarea')?.value).toBe('Typed answer retained');
});

test('ordinary toast Undo without native crypto writes nothing and reports unavailable', async () => {
  const host = await mount(); await click(host, 'Accept');
  unavailableCrypto(); await undo();
  expect(posts).toHaveLength(1);
  const last = toast.getHistory().at(-1);
  expect(last && 'title' in last ? last.title : null).toBe('Unavailable');
});

test('normal list reload changes the version shown without replacing the typed draft', async () => {
  const host = await mount(); await typeReply(host, 'Edit');
  const newer = { ...ordinary, title: 'Reloaded ordinary request', updated: '2026-10-01T10:05:00.000Z' };
  gateway.server = gateway.displayed = newer;
  await act(async () => useInboxStore.getState().setOpenItems(true, [newer])); await settle();
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(newer.title);
  expect(host.querySelector('textarea')?.value).toBe('Typed answer retained');
  await click(host, 'Send');
  expect(posts).toHaveLength(1);
  keyedBody(posts[0]!.body, { text: 'Typed answer retained', action: 'edit', updated: newer.updated });
});

test('ordinary pending answer locks all legal controls and survives Inbox close/remount', async () => {
  const host = await mount();
  let release!: () => void; gateway.gate = new Promise<void>(resolve => { release = resolve; });
  await typeReply(host, 'Respond'); await click(host, 'Send');
  expect(posts).toHaveLength(1);
  for (const label of ['Send', 'Accept', 'Respond', 'Edit', 'Ignore', 'Snooze']) expect(button(host, label).disabled).toBe(true);
  await remount();
  for (const label of ['Accept', 'Respond', 'Edit', 'Ignore', 'Snooze']) expect(button(host, label).disabled).toBe(true);
  await click(host, 'Accept'); expect(posts).toHaveLength(1);
  await act(async () => release()); await settle();
  expect(posts).toHaveLength(1);
});

test('ordinary lost ACK performs one read, never replays, and keeps its uncertain lock after close/remount', async () => {
  const host = await mount(); gateway.lostAck = true;
  await typeReply(host, 'Respond'); await click(host, 'Send');
  expect(posts).toHaveLength(1);
  expect(reads.filter(url => url === '/api/inbox/ordinary%3Aa')).toHaveLength(1);
  expect(host.querySelector('textarea')?.value).toBe('Typed answer retained');
  expect(host.textContent).toContain('Check status');
  expect(button(host, 'Send').disabled).toBe(true);
  await click(host, 'Send'); await remount();
  expect(host.textContent).toContain('Check status');
  for (const label of ['Accept', 'Respond', 'Edit', 'Ignore', 'Snooze']) expect(button(host, label).disabled).toBe(true);
  await click(host, 'Respond'); expect(host.querySelector('textarea')).toBeNull();
  expect(posts).toHaveLength(1);
  await click(host, 'Check status');
  expect(reads.filter(url => url === '/api/inbox/ordinary%3Aa')).toHaveLength(2);
  expect(button(host, 'Respond').disabled).toBe(false);
  expect(posts).toHaveLength(1);
});
