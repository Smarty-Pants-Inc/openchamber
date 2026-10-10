import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useInboxStore, type InboxItem } from '@/lib/smartyInbox';

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLButtonElement: win.HTMLButtonElement, KeyboardEvent: win.KeyboardEvent, Event: win.Event, CustomEvent: win.CustomEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win), MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { StepsLayout } = await import('./StepsLayout');
const { useStepsSheetBack } = await import('./useStepsSheetBack');
const { useNativeAndroidBackButton } = await import('@/apps/mobileNativeChrome');
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const item = (over: Partial<InboxItem> = {}): InboxItem => ({ id: 'step:a:1', to: 'paul', title: 'Release — Run the check',
  actions: ['respond'], source: 'steps:v1:a:01/01', recommendation: 'bun test', links: [],
  priority: 'normal', created: 'v0', updated: 'v1', ...over });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const publish = async (items: InboxItem[]) => act(async () => {
  useInboxStore.getState().setItems(true, items, { capabilities: { guardedReopen: true } });
});
const sheetOpen = () => document.querySelector('select[aria-label="List"]') !== null;

test('removing the last Steps list with All steps open unregisters sheet Back; native Back then reaches the shell', async () => {
  const listeners: (() => void)[] = [];
  let minimized = 0;
  const app = {
    addListener: async (_event: 'backButton', listener: () => void) => { listeners.push(listener); return { remove: async () => {} }; },
    minimizeApp: async () => { minimized++; },
  };
  const loadApp = async () => app;
  let closeSheet: () => boolean = () => false;
  Object.defineProperty(win, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
  function PhoneShell() {
    const back = useStepsSheetBack();
    closeSheet = back.closeSheet;
    useNativeAndroidBackButton(back.closeSheet, loadApp);
    return <StepsLayout mobile sheet={back.sheet}><textarea aria-label="Draft" defaultValue="half-written draft" /></StepsLayout>;
  }
  useInboxStore.getState().setItems(true, []);
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><PhoneShell /></I18nProvider>)); await settle();
    await publish([item()]);
    const allSteps = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'All steps')!;
    await act(async () => allSteps.click()); await settle();
    expect(sheetOpen()).toBe(true);
    // The last eligible list disappears while the sheet is open.
    await publish([]); await settle();
    expect(host.querySelector('[data-steps-row]')).toBeNull();
    expect(sheetOpen()).toBe(false);
    expect(closeSheet()).toBe(false);
    await act(async () => listeners[0]!()); await settle();
    expect(minimized).toBe(1);
    await act(async () => listeners[0]!()); await settle();
    expect(minimized).toBe(2);
    // A list arriving later shows the row with the sheet closed, not a resurrected sheet.
    await publish([item({ id: 'step:b:1', source: 'steps:v1:b:01/01' })]); await settle();
    expect(host.querySelector('[data-steps-row]')).not.toBeNull();
    expect(sheetOpen()).toBe(false);
    expect(host.querySelector('textarea')?.value).toBe('half-written draft');
  } finally {
    await act(async () => root.unmount()); host.remove();
    Reflect.deleteProperty(win, 'Capacitor');
  }
});
