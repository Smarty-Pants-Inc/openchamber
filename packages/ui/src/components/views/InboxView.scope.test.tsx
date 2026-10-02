import { expect, test } from 'bun:test';
import { act } from 'react';
import { ordinary, gateway, posts, reads, mount, click, typeReply, snooze, button, settle, useInboxStore } from './InboxView.guards.fixture';

const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
const { refreshInboxBadge } = await import('@/lib/smartyInbox');
const controls = ['Respond', 'Edit', 'Accept', 'Ignore', '1 hour', '4 hours', '1 day', '1 week', 'Reopen'] as const;
type Control = typeof controls[number];
const responseControls = new Set<Control>(['Respond', 'Edit']);
const hasButton = (host: HTMLElement, label: string) => [...host.querySelectorAll('article button')].some(b => b.textContent?.includes(label));
const listReads = () => reads.filter(url => url.startsWith('/api/inbox?')).length;
function holdList() {
  let release = () => {};
  gateway.listGate = new Promise<void>(resolve => { release = resolve; });
  return async () => { gateway.listGate = null; await act(async () => release()); await settle(); };
}
async function recover() {
  await act(async () => useAuthSessionStore.getState().markAuthenticated());
  await settle();
}
async function attempt(host: HTMLElement, control: Control) {
  if (responseControls.has(control)) {
    if (hasButton(host, 'Send')) await click(host, 'Send');
  } else if (control.startsWith('1 ') || control === '4 hours') {
    if (hasButton(host, 'Snooze') && !button(host, 'Snooze').disabled) await snooze(host, control);
  } else if (hasButton(host, control)) await click(host, control);
}

// Each real control is tried against the display that supplied the original draft.
// A safe implementation may hide or disable it, but must never dispatch it as a renewed operation.
for (const mode of ['pending', 'failed'] as const) for (const control of controls) {
  test(`verified auth recovery with ${mode} replacement list refuses old-display ${control}`, async () => {
    const item = control === 'Reopen' ? { ...ordinary, resolved: { at: ordinary.updated, by: ordinary.to } } : ordinary;
    const host = await mount(item);
    expect(hasButton(host, control.startsWith('1 ') || control === '4 hours' ? 'Snooze' : control)).toBe(true);
    if (control !== 'Reopen') await typeReply(host, responseControls.has(control) ? control : 'Respond');
    const before = listReads();
    if (mode === 'failed') gateway.listStatus = 500;
    const release = mode === 'pending' ? holdList() : async () => {};
    try {
      await recover();
      expect(listReads()).toBeGreaterThan(before);
      if (mode === 'failed') expect(host.querySelector('[role="alert"]')?.textContent).toContain('Replacement list failed');
      await attempt(host, control);
      expect(posts).toHaveLength(0);
      await settle();
      expect(posts).toHaveLength(0);
    } finally { await release(); }
  });
}

for (const person of ['kate', 'paul']) for (const control of ['Respond', 'Edit'] as const) {
  test(`replacement ${person} list with the same item ID never inherits the prior-scope ${control} draft`, async () => {
    const host = await mount();
    await typeReply(host, control);
    const successor = { ...ordinary, to: person, title: 'Successor request', updated: '2026-10-01T11:00:00.000Z' };
    gateway.displayed = gateway.server = successor;
    await recover();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(successor.title);
    expect(host.querySelector('article')?.textContent).toContain(`to ${person}`);
    // Try any surviving Send before starting the successor's own reply.
    if (hasButton(host, 'Send')) await click(host, 'Send');
    expect(posts).toHaveLength(0);
    expect(host.querySelector('textarea')?.value ?? '').toBe('');
    await typeReply(host, control);
    await click(host, 'Send');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ text: 'Typed answer retained', action: control.toLowerCase(), updated: successor.updated });
    expect(gateway.ack.to).toBe(person);
  });
}

for (const kind of ['reload', 'SSE refresh'] as const) for (const control of ['Respond', 'Edit'] as const) {
  test(`same-scope ${kind} retains the ${control} draft and permits its valid write`, async () => {
    const host = await mount();
    await typeReply(host, control);
    const box = host.querySelector('textarea');
    const newer = { ...ordinary, title: 'Current-scope updated request', updated: '2026-10-01T10:05:00.000Z' };
    gateway.displayed = gateway.server = newer;
    if (kind === 'reload') await act(async () => useInboxStore.getState().setOpenItems(true, [newer]));
    // This is the exact public refresh invoked by watchInbox's SSE onmessage, not a copied reducer.
    else await act(async () => refreshInboxBadge());
    await settle();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(newer.title);
    expect(host.querySelector('textarea')).toBe(box);
    expect(host.querySelector('textarea')?.value).toBe('Typed answer retained');
    expect(posts).toHaveLength(0);
    await click(host, 'Send');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ text: 'Typed answer retained', action: control.toLowerCase(), updated: newer.updated });
  });
}

test('a held old-scope list cannot republish its old item after the successor list completes', async () => {
  const host = await mount();
  await typeReply(host, 'Respond');
  gateway.displayed = { ...ordinary, title: 'Late old-scope request' };
  const release = holdList(), before = listReads();
  await act(async () => useInboxStore.getState().setOpenItems(true, [ordinary]));
  await settle();
  expect(listReads()).toBeGreaterThan(before);
  const successor = { ...ordinary, to: 'kate', title: 'Current successor request', updated: '2026-10-01T11:00:00.000Z' };
  gateway.listGate = null;
  gateway.displayed = gateway.server = successor;
  try {
    await recover();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(successor.title);
    await release();
    expect(host.textContent).not.toContain('Late old-scope request');
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(successor.title);
    expect(host.querySelector('textarea')?.value ?? '').toBe('');
    expect(posts).toHaveLength(0);
  } finally { await release(); }
});
