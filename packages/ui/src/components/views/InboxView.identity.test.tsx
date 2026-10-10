import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://inbox.example' });
const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, Event: win.Event, CustomEvent: win.CustomEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win), MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { InboxView } = await import('./InboxView');
const { I18nProvider } = await import('@/lib/i18n');
const { refreshInboxBadge, useInboxStore, watchInbox } = await import('@/lib/smartyInbox');
const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
const { useHumanAuth } = await import('@/lib/human-auth');
const { setPersonalSidebarView, usePersonalSidebarView } = await import('@/lib/sidebar-view');
const originalFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const a = { id: 'shared-id', to: 'person-a', title: 'A private title', actions: ['respond'], links: [],
  priority: 'normal', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' };
const b = { ...a, to: 'person-b', title: 'B private title' };
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(label));
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click()); await settle();
};
function Shell() {
  usePersonalSidebarView();
  React.useEffect(() => watchInbox(), []);
  return <I18nProvider><InboxView onClose={() => {}} /></I18nProvider>;
}

test('sidebar 409 verified A to B recovery immediately clears mounted Inbox content and draft, rejecting late reads and writes', async () => {
  useHumanAuth.setState({ enabled: true });
  let person = a.to, holdA = false;
  let releasePost!: (response: Response) => void;
  const aReads: ((response: Response) => void)[] = [], bReads: ((response: Response) => void)[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/config/sidebar-view')) return init?.method === 'PATCH'
      ? Response.json({}, { status: 409 })
      : Response.json({ owner: { issuer: 'issuer', subject: person }, projects: {}, groups: {} });
    if (init?.method === 'POST') return new Promise(resolve => { releasePost = resolve; });
    if (person === b.to) return new Promise(resolve => { bReads.push(resolve); });
    if (holdA) return new Promise(resolve => { aReads.push(resolve); });
    return Response.json({ person, items: [a], summary: { lines: ['A private summary'] } });
  };
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Shell />)); await settle();
    await click(host, 'Respond');
    const box = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!box) throw new Error('Missing reply draft');
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'A private draft');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(box.value).toBe('A private draft');
    await click(host, 'Send');
    holdA = true;
    await act(async () => useInboxStore.getState().setOpenItems(true, [a])); await settle();
    const oldRead = refreshInboxBadge(); await settle();
    expect(aReads).toHaveLength(2);
    person = b.to;
    const generation = useAuthSessionStore.getState().recoveryGeneration;
    await act(async () => { await setPersonalSidebarView({ projects: { p: true } }).catch(() => undefined); });
    expect(useAuthSessionStore.getState().recoveryGeneration).toBe(generation + 1);
    expect(host.textContent).not.toContain('A private');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[data-inbox-item]')).toBeNull();
    await act(async () => {
      for (const release of aReads) release(Response.json({ person: a.to, items: [a] })); await oldRead;
      releasePost(Response.json({ item: a }));
    }); await settle();
    expect(host.textContent).not.toContain('A private');
    await act(async () => { for (const release of bReads) release(Response.json({ person: b.to, items: [b] })); }); await settle();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(b.title);
    expect(host.querySelector('textarea')).toBeNull();
    expect(useInboxStore.getState().items).toEqual([b]);
  } finally {
    await act(async () => root.unmount()); host.remove(); useHumanAuth.setState({ enabled: false });
  }
});

test('Inbox open across recovery: older bootstrap completes before an action-triggered A+B read without discarding B or its blockers', async () => {
  let recovering = false, allReads = 0;
  let releaseOlder!: (response: Response) => void, releaseNewer!: (response: Response) => void;
  const ask = { ...a, actions: ['accept'] };
  const current = { ...ask, to: b.to, title: 'Current ask' };
  const stepA = { ...b, id: 'step:a', source: 'steps:v1:a:01/01', title: 'A — instruction' };
  const stepB = { ...b, id: 'step:b', source: 'steps:v1:b:01/01', title: 'B — instruction' };
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') return Response.json({ item: current });
    if (!String(input).includes('state=all')) return Response.json({ person: recovering ? b.to : a.to, items: [recovering ? current : ask] });
    allReads++;
    if (!recovering) return Response.json({ person: a.to, items: [ask] });
    return new Promise(resolve => { if (allReads === 2) releaseOlder = resolve; else releaseNewer = resolve; });
  };
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Shell />)); await settle();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(ask.title);
    recovering = true;
    await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(current.title);
    await click(host, 'Accept');
    expect(allReads).toBe(3);
    await act(async () => releaseOlder(Response.json({ person: b.to, items: [stepA] }))); await settle();
    await act(async () => releaseNewer(Response.json({ person: b.to, items: [stepA, stepB,
      { to: b.to, source: stepB.source, title: 123 }], capabilities: { guardedReopen: true } }))); await settle();
    expect(useInboxStore.getState().items).toEqual([stepA, stepB]);
    expect(useInboxStore.getState().invalidStepGroups).toEqual([JSON.stringify([b.to, 'b'])]);
    expect(useInboxStore.getState().snapshotValid).toBe(true);
    expect(allReads).toBe(3);
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(current.title);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
