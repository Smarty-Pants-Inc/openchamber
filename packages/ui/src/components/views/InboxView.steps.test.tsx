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
const { StepsLayout } = await import('@/components/chat/steps/StepsLayout');
const { clearStepActionStatuses } = await import('@/lib/inboxStepActions');
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
  toast.dismiss(); posts.length = 0; clearStepActionStatuses();
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

for (const steps of [true, false]) test(`${steps ? 'Steps' : 'ordinary Inbox'} Snooze guards the displayed version; Undo requires guarded capability`, async () => {
  const host = await mount(steps ? open : { ...open, source: 'net-lead' }, !steps);
  await click(host, 'Snooze');
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('1 hour'));
  if (!choice) throw new Error('Missing 1 hour snooze');
  await act(async () => choice.click()); await settle();
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/snooze', body: { for: '1h', updated: open.updated } }]);
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

test('ordinary Inbox Respond uses strict displayed guards without Done and supported resolved items retain Reopen', async () => {
  const ordinary = { ...open, source: 'net-lead' };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let host = await mount(ordinary, true);
  await respond(host);
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/answer', body: { text: 'A generic response', action: 'respond', updated: ordinary.updated, opKey: posts[0]?.body.opKey } }]);
  expect(uuid.test(posts[0]?.body.opKey ?? '')).toBe(true);
  const answerKey = posts[0]?.body.opKey;
  expect(isStepDone(useInboxStore.getState().items[0]!)).toBe(false);
  expect(host.textContent).not.toContain('Step marked done');
  await unmount(); posts.length = 0;
  host = await mount({ ...ordinary, resolved: { at: ordinary.updated } }, true);
  await click(host, 'Reopen');
  expect(posts).toEqual([{ url: '/api/inbox/step%3Aa/reopen', body: { updated: ordinary.updated, opKey: posts[0]?.body.opKey } }]);
  expect(uuid.test(posts[0]?.body.opKey ?? '')).toBe(true);
  expect(posts[0]?.body.opKey).not.toBe(answerKey);
});

// The pinned row stays mounted while the Inbox mounts conditionally (desktop and phone shells).
const mountShell = async (inbox: boolean) => {
  displayed = stored = open;
  useInboxStore.getState().setItems(true, [open], { capabilities: { guardedReopen: true } });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (withInbox: boolean) => {
    await act(async () => root.render(<I18nProvider><StepsLayout><p>chat</p></StepsLayout>
      {withInbox && <InboxView onClose={() => {}} />}</I18nProvider>)); await settle();
  };
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await render(inbox);
  return { host, render };
};
const rowButton = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-steps-row] button')].find(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').startsWith(label));
const inboxButton = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('article button')].find(button => button.textContent?.includes(label));
const lossyGateway = (state: { online: boolean; holdPost?: Promise<void> }) => { globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/auth/url-token')) return Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 });
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    if (state.holdPost) await state.holdPost;
    throw new Error('lost acknowledgement');
  }
  if (url === '/api/inbox/step%3Aa') {
    if (!state.online) throw new Error('offline reconciliation');
    return Response.json({ item: open });
  }
  return Response.json({ person: 'paul', items: [open], capabilities: { guardedReopen: true } });
}; };

test('an uncertain Inbox response keeps the row locked after closing Inbox and again after reopening it', async () => {
  const state = { online: false };
  lossyGateway(state);
  const shell = await mountShell(true);
  await respond(shell.host);
  expect(posts).toHaveLength(1);
  expect(inboxButton(shell.host, 'Check status')).toBeDefined();
  await shell.render(false);
  expect(shell.host.querySelector('article')).toBeNull();
  // Closing Inbox must not hand the row a fresh, unlocked action state for the same item.
  // Compare a boolean: printing a happy-dom element on failure does not terminate.
  expect(rowButton(shell.host, 'Mark step') === undefined).toBe(true);
  expect(rowButton(shell.host, 'Check status')).toBeDefined();
  await act(async () => rowButton(shell.host, 'Mark step')?.click()); await settle();
  expect(posts).toHaveLength(1);
  await shell.render(true);
  expect(inboxButton(shell.host, 'Check status')).toBeDefined();
  expect(inboxButton(shell.host, 'Respond')?.disabled).toBe(true);
  expect(posts).toHaveLength(1);
  // Only an explicit successful read releases the lock, for both entry points.
  state.online = true;
  await act(async () => rowButton(shell.host, 'Check status')!.click()); await settle();
  expect(inboxButton(shell.host, 'Respond')?.disabled).toBe(false);
  expect(rowButton(shell.host, 'Mark step')?.disabled).toBe(false);
  expect(posts).toHaveLength(1);
});

test('an uncertain row Done keeps the Inbox locked when the Inbox opens afterwards', async () => {
  const state = { online: false };
  lossyGateway(state);
  const shell = await mountShell(false);
  await act(async () => rowButton(shell.host, 'Mark step')!.click()); await settle();
  expect(posts).toHaveLength(1);
  expect(rowButton(shell.host, 'Check status')).toBeDefined();
  await shell.render(true);
  expect(shell.host.querySelector('article')?.getAttribute('aria-label')).toBe(open.title);
  expect(inboxButton(shell.host, 'Check status')).toBeDefined();
  expect(inboxButton(shell.host, 'Respond')?.disabled).toBe(true);
  await act(async () => inboxButton(shell.host, 'Respond')!.click()); await settle();
  expect(shell.host.querySelector('textarea')).toBeNull();
  expect(posts).toHaveLength(1);
  state.online = true;
  await click(shell.host, 'Check status');
  expect(inboxButton(shell.host, 'Respond')?.disabled).toBe(false);
  expect(rowButton(shell.host, 'Mark step')?.disabled).toBe(false);
});

test('closing Inbox while its Steps write is still pending keeps the row from dispatching another write', async () => {
  let release!: () => void;
  const state = { online: true, holdPost: new Promise<void>(resolve => { release = resolve; }) };
  lossyGateway(state);
  const shell = await mountShell(true);
  await respond(shell.host);
  expect(posts).toHaveLength(1);
  await shell.render(false);
  expect(shell.host.querySelector('[data-steps-row]')?.textContent).toContain('Saving');
  expect(rowButton(shell.host, 'Mark step')?.disabled).toBe(true);
  await act(async () => rowButton(shell.host, 'Mark step')!.click()); await settle();
  expect(posts).toHaveLength(1);
  await act(async () => release()); await settle();
  expect(posts).toHaveLength(1);
});
