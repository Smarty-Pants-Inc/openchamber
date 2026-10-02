import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import type { InboxItem } from '@/lib/smartyInbox';
import { isStepDone } from '@/lib/inboxSteps';

const win = new Window({ url: 'http://localhost' });
const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, Event: win.Event, requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win), MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { InboxView } = await import('./InboxView');
const { I18nProvider } = await import('@/lib/i18n');
const { useInboxStore } = await import('@/lib/smartyInbox');
const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const open: InboxItem = { id: 'step:a', to: 'paul', title: 'Topic — instruction', source: 'steps:v1:a:01/01', actions: ['respond'],
  links: [], priority: 'normal', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' };
let displayed = open;
let stored = open;
const posts: { url: string; body: { text?: string; action?: string; updated?: string; opKey?: string; for?: string } }[] = [];
const installGateway = () => { globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/auth/url-token')) return Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 });
  if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); displayed = stored; return Response.json({ item: stored }); }
  return Response.json({ person: 'paul', items: [displayed], capabilities: { guardedReopen: useInboxStore.getState().guardedReopen } });
}; };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
let unmount = async () => {};
afterEach(async () => {
  await unmount(); unmount = async () => {};
  globalThis.fetch = originalFetch;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  toast.dismiss(); posts.length = 0;
});
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const mount = async (item = open, guardedReopen = false) => {
  displayed = stored = item; installGateway();
  useInboxStore.getState().setItems(true, [item], { capabilities: { guardedReopen } });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(<I18nProvider><InboxView onClose={() => {}} /></I18nProvider>)); await settle();
  return host;
};
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent?.includes(label));
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click()); await settle();
};
const respond = async (host: HTMLElement) => {
  await click(host, 'Respond');
  const box = host.querySelector<HTMLTextAreaElement>('textarea');
  if (!box) throw new Error('Missing response textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'A generic response');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(host, 'Send');
};

test('generic Steps Respond sends displayed version and a fresh op key, stores its guarded acknowledgement without a Done label or tick', async () => {
  const host = await mount();
  const stamp = { at: '2026-10-01T10:01:00.000Z', by: open.to, action: 'respond' };
  stored = { ...open, updated: stamp.at, answer: { ...stamp, text: 'A generic response' }, resolved: stamp };
  await respond(host);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ url: '/api/inbox/step%3Aa/answer', body: { text: 'A generic response', action: 'respond', updated: open.updated } });
  expect(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(posts[0]?.body.opKey ?? '')).toBe(true);
  expect(useInboxStore.getState().items).toEqual([stored]);
  expect(isStepDone(useInboxStore.getState().items[0]!)).toBe(false);
  expect(host.textContent).not.toContain('Step marked done');
});

test('Steps with unsupported guarded reopen show an explanation and no Reopen write affordance', async () => {
  const resolved = { ...open, resolved: { at: open.updated, by: open.to, action: 'respond' } };
  const host = await mount(resolved);
  expect([...host.querySelectorAll('article button')].map(button => button.textContent)).not.toContain('Reopen');
  expect(host.textContent).toContain('Undo unavailable');
  expect(posts).toEqual([]);
});

for (const steps of [true, false]) test(`${steps ? 'Steps' : 'ordinary Inbox'} Snooze keeps the existing write; only ordinary Inbox offers unguarded Undo`, async () => {
  const host = await mount(steps ? open : { ...open, source: 'net-lead' });
  await click(host, 'Snooze');
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('1 hour'));
  if (!choice) throw new Error('Missing 1 hour snooze');
  await act(async () => choice.click()); await settle();
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/snooze', body: { for: '1h' } }]);
  const last = toast.getHistory().at(-1);
  expect(last && 'title' in last ? last.title : null).toBe('Snoozed for 1 hour');
  const action = last && 'action' in last ? last.action : undefined;
  expect(JSON.stringify(action)?.includes('"label":"Undo"')).toBe(!steps);
  expect(host.textContent?.includes('Undo unavailable')).toBe(steps);
});

test('supported Steps Reopen uses the displayed resolved version and a fresh key, not an unguarded write', async () => {
  const resolved = { ...open, resolved: { at: open.updated, by: open.to, action: 'respond' } };
  const host = await mount(resolved, true);
  stored = { ...open, updated: '2026-10-01T10:02:00.000Z' };
  await click(host, 'Reopen');
  expect(posts[0]).toMatchObject({ url: '/api/inbox/step%3Aa/reopen', body: { updated: resolved.updated } });
  expect(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(posts[0]?.body.opKey ?? '')).toBe(true);
});

test('missing runtime UUID is explicitly unavailable before a generic Steps answer dispatch', async () => {
  const host = await mount();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  await respond(host);
  expect(posts).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Unavailable');
  expect(host.querySelector('textarea')?.value).toBe('A generic response');
});

for (const outcome of ['502', 'lost ACK'] as const) {
  for (const recovery of ['stored', 'failed'] as const) test(`Steps Respond ${outcome} locks Send during its one read and ${recovery} reconciliation never replays`, async () => {
    const host = await mount();
    const stamp = { at: '2026-10-01T10:01:00.000Z', by: open.to, action: 'respond' };
    const committed = { ...open, updated: stamp.at, answer: { ...stamp, text: 'A generic response' }, resolved: stamp };
    let releaseRead!: (response: Response) => void, rejectRead!: (error: Error) => void;
    let reads = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (outcome === 'lost ACK') throw new Error('lost acknowledgement');
        return Response.json({ data: { message: 'Acknowledgement unavailable' } }, { status: 502 });
      }
      if (url === '/api/inbox/step%3Aa') {
        reads++;
        return new Promise((resolve, reject) => { releaseRead = resolve; rejectRead = reject; });
      }
      return Response.json({ person: 'paul', items: [displayed] });
    };
    await respond(host);
    const send = () => [...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent === 'Send')!;
    expect(reads).toBe(1);
    expect(send().disabled).toBe(true);
    await click(host, 'Send'); expect(posts).toHaveLength(1);
    await act(async () => {
      if (recovery === 'failed') rejectRead(new Error('offline item read'));
      else { displayed = committed; releaseRead(Response.json({ item: committed })); }
    }); await settle();
    expect(send().disabled).toBe(true);
    expect(host.textContent).toContain('Check status');
    await click(host, 'Send'); expect(posts).toHaveLength(1); expect(reads).toBe(1);
    if (recovery === 'stored') {
      expect(useInboxStore.getState().items).toEqual([committed]);
      expect(host.textContent).toContain('Answered (respond): A generic response');
    } else {
      await click(host, 'Check status');
      expect(reads).toBe(2); expect(send().disabled).toBe(true);
      await act(async () => rejectRead(new Error('still offline'))); await settle();
      expect(send().disabled).toBe(true); expect(host.textContent).toContain('Check status');
      await click(host, 'Send'); expect(posts).toHaveLength(1);
      await click(host, 'Check status');
      const current = { ...open, updated: stamp.at };
      // The tab list still returns the old version; the item read is the newer authority.
      await act(async () => releaseRead(Response.json({ item: current }))); await settle();
      expect(send().disabled).toBe(false);
      await click(host, 'Send');
      expect(posts).toHaveLength(2);
      expect(posts[1]?.body.updated).toBe(current.updated);
      expect(posts[1]?.body.opKey).not.toBe(posts[0]?.body.opKey);
      // Settle the second uncertain write's read before ending the test.
      await act(async () => releaseRead(Response.json({ item: current }))); await settle();
    }
  });
}

for (const outcome of ['502', 'lost ACK'] as const) test(`Steps Reopen ${outcome} uses one-read reconciliation and remains locked until Check status`, async () => {
  const resolved = { ...open, resolved: { at: open.updated, by: open.to, action: 'respond' } };
  const host = await mount(resolved, true);
  let releaseRead!: (response: Response) => void, reads = 0;
  let authoritative: InboxItem = resolved;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (outcome === 'lost ACK') throw new Error('lost acknowledgement');
      return Response.json({ data: { message: 'Acknowledgement unavailable' } }, { status: 502 });
    }
    if (url === '/api/inbox/step%3Aa') { reads++; return new Promise(resolve => { releaseRead = resolve; }); }
    return Response.json({ person: 'paul', items: [url.includes('state=all') ? authoritative : resolved], capabilities: { guardedReopen: true } });
  };
  await click(host, 'Reopen');
  expect(reads).toBe(1);
  expect([...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent === 'Reopen')?.disabled).toBe(true);
  await click(host, 'Reopen'); expect(posts).toHaveLength(1);
  const reopened = { ...open, updated: '2026-10-01T10:02:00.000Z' };
  await act(async () => { authoritative = reopened; releaseRead(Response.json({ item: reopened })); }); await settle();
  expect(useInboxStore.getState().items).toEqual([reopened]);
  expect(host.textContent).toContain('Check status');
  expect([...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent?.includes('Respond'))?.disabled).toBe(true);
  await click(host, 'Check status');
  await act(async () => releaseRead(Response.json({ item: reopened }))); await settle();
  expect([...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent?.includes('Respond'))?.disabled).toBe(false);
  expect(posts).toHaveLength(1); expect(reads).toBe(2);
});

test('a failed Steps response keeps its uncertainty lock after selecting another item and changing tabs', async () => {
  const host = await mount();
  const other = { ...open, id: 'ordinary', source: 'net-lead', title: 'Other item' };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); throw new Error('lost acknowledgement'); }
    if (url === '/api/inbox/step%3Aa') throw new Error('offline reconciliation');
    return Response.json({ person: 'paul', items: [open, other] });
  };
  await respond(host);
  expect(host.textContent).toContain('Check status');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-inbox-item="ordinary"]')!.click()); await settle();
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(other.title);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-inbox-item="step:a"]')!.click()); await settle();
  expect(host.textContent).toContain('Check status');
  const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.startsWith(label))!;
  await act(async () => tab('Resolved').click()); await settle();
  await act(async () => tab('Open').click()); await settle();
  expect(host.textContent).toContain('Check status');
  expect([...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent?.includes('Respond'))?.disabled).toBe(true);
  await click(host, 'Respond'); expect(host.querySelector('textarea')).toBeNull();
  expect(posts).toHaveLength(1);
});

test('ordinary Inbox Respond remains unguarded and ordinary resolved items retain Reopen', async () => {
  const ordinary = { ...open, source: 'net-lead' };
  let host = await mount(ordinary);
  await respond(host);
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/answer', body: { text: 'A generic response', action: 'respond' } }]);
  await unmount(); posts.length = 0;
  host = await mount({ ...ordinary, resolved: { at: ordinary.updated } });
  await click(host, 'Reopen');
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/reopen', body: {} }]);
});
