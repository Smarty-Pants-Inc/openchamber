import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { refreshInboxBadge, useInboxStore, type InboxItem } from '@/lib/smartyInbox';
import { STEP_DONE_REPORT } from '@/lib/inboxSteps';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLButtonElement: win.HTMLButtonElement, KeyboardEvent: win.KeyboardEvent, Event: win.Event, CustomEvent: win.CustomEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win), MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { StepsLayout } = await import('./StepsLayout');
const originalFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const item = (over: Partial<InboxItem> = {}): InboxItem => ({ id: 'step:a:1', to: 'paul', title: 'Release — Run the check',
  actions: ['respond'], source: 'steps:v1:a:01/01', recommendation: '  printf "%s" "é"  ', links: [],
  priority: 'normal', created: 'v0', updated: 'v1', ...over });
const json = (body: { item?: InboxItem; items?: InboxItem[] }) => new Response(JSON.stringify({ ...body,
  person: 'paul', capabilities: { guardedReopen: true } }), { headers: { 'content-type': 'application/json' } });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const mount = async (mobile = false) => {
  useInboxStore.getState().setItems(true, []);
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider><StepsLayout mobile={mobile}>
    <textarea aria-label="Draft" defaultValue="half-written draft" /><div data-scrollbar="chat"><p>Reading anchor</p></div>
  </StepsLayout></I18nProvider>));
  const scroller = host.querySelector<HTMLElement>('[data-scrollbar="chat"]')!;
  const chrome = () => host.querySelector('[data-steps-row]') ? mobile ? 160 : 128 : 0;
  // happy-dom has no layout. These getters model the actual flex viewport's top and reduced height.
  Object.defineProperties(scroller, { scrollHeight: { get: () => 2000 }, clientHeight: { get: () => 600 - chrome() },
    getBoundingClientRect: { value: () => ({ top: 200 + chrome() }) } });
  return { host, root, scroller, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
};
const publish = async (items: InboxItem[], guardedReopen = true) => act(async () => {
  useInboxStore.getState().setItems(true, items, { capabilities: { guardedReopen } });
});
const button = (host: Element, label: string) => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith(label))!;

test('row appearance/disappearance holds the reading anchor, draft, focus and mounted timeline on desktop and phone', async () => {
  for (const mobile of [false, true]) {
    const view = await mount(mobile);
    const draft = view.host.querySelector('textarea')!;
    draft.focus(); draft.setSelectionRange(4, 8); view.scroller.scrollTop = 500;
    const anchor = () => view.scroller.getBoundingClientRect().top + 800 - view.scroller.scrollTop;
    expect(anchor()).toBe(500);
    await publish([item()]);
    expect(anchor()).toBe(500); expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe('half-written draft'); expect(draft.selectionStart).toBe(4);
    expect(view.host.querySelector('[data-scrollbar="chat"]')).toBe(view.scroller);
    expect(view.scroller.querySelector('[data-steps-row]')).toBeNull();
    await publish([]); expect(anchor()).toBe(500); expect(document.activeElement).toBe(draft);
    await view.cleanup();
  }
});

test('a reader at the end remains there; receiving partial steps disables actions', async () => {
  const view = await mount(); view.scroller.scrollTop = 1400;
  await publish([item({ source: 'steps:v1:a:01/02' })]);
  expect(view.scroller.scrollTop).toBe(1528);
  expect(view.host.textContent).toContain('Receiving 1 of 2 steps');
  expect(button(view.host, 'Copy step')).toBeUndefined();
  await publish([]); expect(view.scroller.scrollTop).toBe(1400);
  await view.cleanup();
});

test('Copy is byte-exact, never ticks; only successful clipboard acknowledgement announces Copied', async () => {
  const view = await mount(); const copied: string[] = []; let refuse = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
    if (refuse) throw new Error('denied'); copied.push(text);
  } } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
  await publish([item()]);
  await act(async () => button(view.host, 'Copy step').click()); await settle();
  expect(copied).toEqual([item().recommendation!]); expect(view.host.textContent).toContain('Copied');
  expect(button(view.host, 'Mark step').getAttribute('aria-pressed')).toBe('false');
  refuse = true;
  const draft = view.host.querySelector('textarea')!; draft.focus(); draft.setSelectionRange(4, 8);
  await act(async () => button(view.host, 'Copy step').click()); await settle();
  expect(document.activeElement).toBe(draft); expect(draft.selectionStart).toBe(4);
  expect(view.host.textContent).toContain('Copy failed'); expect(view.host.textContent).not.toContain('Copied');
  for (const recommendation of ['echo safe\u001b[2J', 'echo one\necho two', 'echo one\r\necho two']) {
    await publish([item({ recommendation })]);
    expect(button(view.host, 'Copy step').disabled).toBe(true);
    expect(view.host.querySelector('code')?.textContent).toBe(recommendation);
  }
  await view.cleanup();
});

test('Done waits for the stored answer, rapid double click writes once, Undo uses the acknowledged version', async () => {
  const view = await mount(); const posts: { url: string; body: string }[] = [];
  let release!: (r: Response) => void;
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const stamp = { at: 'v2', by: 'paul', action: 'respond' };
  const done = item({ updated: 'v2', answer: { ...stamp, text: STEP_DONE_REPORT }, resolved: stamp });
  let stored = item();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method !== 'POST') return json({ items: [stored], item: stored });
    posts.push({ url, body: String(init.body) });
    if (url.endsWith('/answer')) { const response = await gate; stored = done; return response; }
    stored = item({ updated: 'v3' }); return json({ item: stored });
  };
  await publish([item()]);
  view.scroller.scrollTop = 628;
  await act(async () => { const doneButton = button(view.host, 'Mark step'); doneButton.focus(); doneButton.click(); doneButton.click(); }); await settle();
  expect(posts).toHaveLength(1); expect(view.host.textContent).toContain('Saving');
  expect(view.host.textContent).toContain('0 of 1 done');
  await act(async () => release(json({ item: done }))); await settle();
  expect(view.host.textContent).toContain('1 of 1 done');
  expect(view.scroller.scrollTop).toBe(628); expect(document.activeElement).toBe(button(view.host, 'Undo Done'));
  expect(view.host.querySelector('textarea')?.value).toBe('half-written draft');
  await act(async () => button(view.host, 'Undo Done').click()); await settle();
  expect(posts).toHaveLength(2); expect(posts[1]?.url.endsWith('/reopen')).toBe(true);
  expect(JSON.parse(posts[1]!.body)).toMatchObject({ updated: 'v2' });
  expect(view.host.textContent).toContain('0 of 1 done');
  await view.cleanup();
});

test('snoozed Done refuses clicks while Copy remains available; the same item enables Done after expiry', async () => {
  const view = await mount(), snoozed = item({ snoozedUntil: new Date(Date.now() + 100).toISOString() }); let posts = 0;
  globalThis.fetch = async (_input, init) => { if (init?.method === 'POST') posts++; return json({ items: [snoozed] }); }; await publish([snoozed]);
  expect(button(view.host, 'Mark step').disabled).toBe(true); expect(button(view.host, 'Copy step').disabled).toBe(false);
  await act(async () => button(view.host, 'Mark step').click()); expect(posts).toBe(0);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(button(view.host, 'Mark step').disabled).toBe(false); expect(posts).toBe(0); await view.cleanup();
});
test('generic resolutions never tick; conflicting groups never render a checklist or block unrelated lists', async () => {
  const view = await mount();
  await publish([item({ resolved: { at: 'v2', by: 'agent', action: 'ignore' } })]);
  expect(view.host.textContent).toContain('0 of 1 done');
  expect(button(view.host, 'Mark step').disabled).toBe(true);
  expect(view.host.textContent).toContain('Resolved without a Done report');
  const other = item({ id: 'step:b:1', source: 'steps:v1:b:01/01', title: 'Other — instruction' });
  await publish([item(), item({ id: 'duplicate' }), other]);
  expect(view.host.querySelector('[data-step-id]')?.getAttribute('data-step-id')).toBe(other.id);
  await publish([item(), item({ id: 'malformed', source: 'steps:v1:a:0/01' })]);
  expect(view.host.querySelector('[data-steps-row]')).toBeNull();
  await view.cleanup();
});

test('unsupported Undo stays hidden with a visible reason, while a recorded Done tick remains', async () => {
  const view = await mount(); const stamp = { at: 'v2', by: 'paul', action: 'respond' };
  await publish([item({ updated: 'v2', answer: { ...stamp, text: STEP_DONE_REPORT }, resolved: stamp })], false);
  expect(view.host.textContent).toContain('1 of 1 done');
  expect(view.host.textContent).toContain('Undo unavailable: installed inbox does not support guarded reopen.');
  expect(button(view.host, 'Undo Done')).toBeUndefined();
  await view.cleanup();
});

test('new lists do not replace selection; desktop dropdown and phone sheet close without clearing the draft', async () => {
  for (const mobile of [false, true]) {
    const view = await mount(mobile); await publish([item()]);
    const other = item({ id: 'step:b:1', source: 'steps:v1:b:01/01', title: 'Another — next' });
    await publish([other, item()]);
    expect(view.host.querySelector('[data-step-id]')?.getAttribute('data-step-id')).toBe('step:a:1');
    const trigger = button(view.host, 'All steps');
    await act(async () => trigger.click()); await settle();
    const picker = document.querySelector<HTMLSelectElement>('select[aria-label="List"]');
    expect(picker).not.toBeNull(); expect(picker?.value).toBe(JSON.stringify(['paul', 'a']));
    await act(async () => { picker!.value = JSON.stringify(['paul', 'b']); picker!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(view.host.querySelector('[data-step-id]')?.getAttribute('data-step-id')).toBe('step:b:1');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await settle();
    expect(view.host.querySelector('textarea')?.value).toBe('half-written draft');
    expect(document.activeElement).toBe(trigger);
    await view.cleanup();
  }
});

test('Check status returning unchanged A cannot discard an in-flight all-state arrival of list B', async () => {
  const view = await mount();
  const a = item({ created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' });
  const b = item({ id: 'step:b:1', source: 'steps:v1:b:01/01', title: 'Another — next', created: a.created, updated: a.updated });
  let holdAll = false, releaseAll!: (response: Response) => void;
  let itemReads = 0, posts = 0, allReads = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') { posts++; throw new Error('lost acknowledgement'); }
    if (String(input).includes('state=all')) {
      allReads++;
      return holdAll ? new Promise(resolve => { releaseAll = resolve; }) : json({ items: [a] });
    }
    itemReads++;
    if (itemReads === 1) throw new Error('offline reconciliation');
    return json({ item: a });
  };
  try {
    await publish([a]);
    await act(async () => button(view.host, 'Mark step').click()); await settle();
    expect(view.host.textContent).toContain('Check status');
    holdAll = true;
    const pending = refreshInboxBadge(); await settle();
    await act(async () => [...view.host.querySelectorAll('button')].find(b => b.textContent === 'Check status')!.click()); await settle();
    await act(async () => { releaseAll(json({ items: [a, b] })); await pending; }); await settle();
    expect(useInboxStore.getState().items).toEqual([a, b]);
    expect(useInboxStore.getState().openCount).toBe(2);
    await act(async () => button(view.host, 'All steps').click()); await settle();
    expect([...document.querySelectorAll('select[aria-label="List"] option')].map(option => option.textContent)).toContain('Another');
    expect(posts).toBe(1); expect(itemReads).toBe(2); expect(allReads).toBe(2);
  } finally { await view.cleanup(); }
});

test('a write completing after a runtime/identity switch cannot publish into the new inbox', async () => {
  const view = await mount(); let release!: (response: Response) => void; let gets = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Promise(resolve => { release = resolve; });
    gets += 1; return json({ items: [] });
  };
  await publish([item()]);
  await act(async () => button(view.host, 'Mark step').click()); await settle();
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://new-runtime', runtimeKey: 'new-owner' }));
  const other = item({ to: 'other', updated: 'other-version', title: 'Other — instruction' });
  await publish([other]);
  const stamp = { at: 'v2', by: 'paul', action: 'respond' };
  await act(async () => release(json({ item: item({ updated: 'v2', answer: { ...stamp, text: STEP_DONE_REPORT }, resolved: stamp }) })));
  await settle();
  expect(useInboxStore.getState().items).toEqual([other]); expect(gets).toBe(0);
  expect(view.host.textContent).toContain('0 of 1 done');
  await view.cleanup();
});
