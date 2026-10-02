import { afterAll, afterEach } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { toast, Toaster } from 'sonner';
import { z } from 'zod';
import type { InboxItem } from '@/lib/smartyInbox';

// Same real-fetch/DOM boundary as InboxView.steps.test.tsx. No component or module mocks.
const win = new Window({ url: 'http://localhost' });
const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, Event: win.Event, requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win), getComputedStyle: win.getComputedStyle.bind(win),
  MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { InboxView } = await import('./InboxView');
const { I18nProvider } = await import('@/lib/i18n');
export const { useInboxStore } = await import('@/lib/smartyInbox');
const { clearStepActionStatuses } = await import('@/lib/inboxStepActions');
const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
export const ordinary: InboxItem = { id: 'ordinary:a', to: 'paul', title: 'Ordinary request', source: 'net-lead',
  actions: ['accept', 'respond', 'edit', 'ignore'], links: [], priority: 'normal',
  created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' };
const bodySchema = z.object({ text: z.string().optional(), action: z.string().optional(), updated: z.string().optional(),
  opKey: z.string().optional(), for: z.string().optional(), to: z.string().optional() }).strict();
export const posts: { url: string; body: z.infer<typeof bodySchema> }[] = [];
export const reads: string[] = [];
type FixtureGateway = { displayed: InboxItem; server: InboxItem; status: number; lostAck: boolean;
  gate: Promise<void> | null; listGate: Promise<void> | null; listStatus: number; ack: InboxItem; reason: string };
export const gateway: FixtureGateway = {
  displayed: ordinary, server: ordinary, status: 200, lostAck: false, gate: null, listGate: null, listStatus: 200,
  ack: ordinary, reason: 'Displayed item changed; nothing was sent' };
let unmount = async () => {};
export let remount = async () => {};
export const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
afterEach(async () => {
  await unmount(); unmount = async () => {};
  globalThis.fetch = originalFetch;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  toast.dismiss(); posts.length = 0; reads.length = 0; clearStepActionStatuses();
});
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
export async function mount(item = ordinary) {
  Object.assign(gateway, { displayed: item, server: item, status: 200, lostAck: false, gate: null, listGate: null, listStatus: 200, ack: item });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/url-token')) return Response.json({ token: 'fixture-token', expiresAt: Date.now() + 60_000 });
    if (init?.method === 'POST') {
      const body = bodySchema.parse(JSON.parse(String(init.body)));
      posts.push({ url, body });
      if (gateway.gate) await gateway.gate;
      if (gateway.lostAck) throw new Error('Lost acknowledgement');
      if (gateway.status !== 200) return Response.json({ data: { message: gateway.reason } }, { status: gateway.status });
      const updated = new Date(Date.parse(gateway.server.updated) + 60_000).toISOString();
      const stamp = { at: updated, by: gateway.server.to, action: body.action };
      const ack: InboxItem = { ...gateway.server, updated };
      if (url.endsWith('/answer')) { ack.answer = { ...stamp, text: body.text }; ack.resolved = stamp; }
      if (url.endsWith('/resolve')) ack.resolved = stamp;
      if (url.endsWith('/snooze')) ack.snoozedUntil = '2099-10-01T10:00:00.000Z';
      if (url.endsWith('/reopen')) { delete ack.answer; delete ack.resolved; delete ack.snoozedUntil; }
      gateway.ack = gateway.displayed = gateway.server = ack;
      return Response.json({ person: ack.to, item: ack });
    }
    reads.push(url);
    if (url === '/api/inbox/ordinary%3Aa') return Response.json({ item: gateway.server });
    const displayed = gateway.displayed, status = gateway.listStatus;
    if (gateway.listGate) await gateway.listGate;
    if (status !== 200) return Response.json({ data: { message: 'Replacement list failed' } }, { status });
    return Response.json({ person: displayed.to, items: [displayed], capabilities: { guardedReopen: true } });
  };
  useInboxStore.getState().setItems(true, [item], { capabilities: { guardedReopen: true } });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const render = async (visible: boolean) => {
    await act(async () => root.render(<I18nProvider>{visible && <InboxView onClose={() => {}} />}<Toaster /></I18nProvider>)); await settle();
  };
  remount = async () => { await render(false); await render(true); };
  await render(true);
  return host;
}
export function button(host: HTMLElement, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('article button')].find(b => b.textContent?.includes(label));
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
}
export async function click(host: HTMLElement, label: string) {
  await act(async () => button(host, label).click()); await settle();
}
export async function typeReply(host: HTMLElement, label: string) {
  await click(host, label);
  const box = host.querySelector<HTMLTextAreaElement>('textarea');
  if (!box) throw new Error('Missing reply textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Typed answer retained');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
export async function snooze(host: HTMLElement, label: string) {
  await click(host, 'Snooze');
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label);
  if (!choice) throw new Error(`Missing ${label} snooze`);
  await act(async () => choice.click()); await settle();
}
export async function undo() {
  const action = [...document.querySelectorAll<HTMLButtonElement>('[data-sonner-toast] button')].find(b => b.textContent === 'Undo');
  if (!action) throw new Error('Missing toast Undo');
  await act(async () => action.click()); await settle();
}
export function unavailableCrypto() { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} }); }
