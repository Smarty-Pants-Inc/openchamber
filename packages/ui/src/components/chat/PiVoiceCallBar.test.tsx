import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

// A live call keeps a visible End on every screen. The bar reads the page's call and the session in
// view from the session UI store, never the view's capability or layout. App.tsx mounts it in the
// app shell, above MainLayout's mobile/desktop split and ChatContainer's composer/view-only gates.
const sessions = [{ id: 'org', title: 'org session' }];
const store = { subscribe: () => () => undefined, getState: () => ({ session: sessions }) };
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => store }));
// The session in view, as the app's session UI store holds it (the real store needs the whole sync runtime).
const { create } = await import('zustand');
const useSessionUIStore = create<{ currentSessionId: string | null }>()(() => ({ currentSessionId: null }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { PiVoiceCallBar } = await import('./PiVoiceCallBar');
const { I18nProvider } = await import('@/lib/i18n');
const voice = await import('@/lib/voice/piVoiceActiveCall');
const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');

const NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
afterEach(() => {
  voice.endActivePiVoiceCall();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function view(viewedSessionId: string | null, width = 1280) {
  useSessionUIStore.setState({ currentSessionId: viewedSessionId });
  const happy = new Window({ url: 'https://code.example.test', width, height: 800 });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><PiVoiceCallBar /></I18nProvider>); });
  return { container, unmount: () => act(() => root.unmount()) };
}
const endButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label="End the voice call"]');

test('no call, no bar', async () => {
  const { container, unmount } = await view('org');
  expect(container.querySelectorAll('button')).toHaveLength(0);
  unmount();
});

for (const [screen, viewed, width] of [['a new draft', null, 1280], ['a view-only fleet session', 'fleet-row', 1280],
  ['a phone-width layout', 'org', 390], ['a view-only session on a phone', 'fleet-row', 390]] as const) {
  test(`a live call keeps a working End on ${screen}`, async () => {
    const { driver, calls } = fakePiVoiceDriver();
    await voice.startPiVoiceCallFor('org', '/p', driver, { onEnded() {}, onFailed() {} });
    const { container, unmount } = await view(viewed, width);
    if (viewed !== 'org') expect(container.textContent).toContain('in org session'); // Which session the call belongs to.
    const end = endButton(container);
    expect(end).not.toBeNull();
    await act(async () => { end?.click(); });
    expect(voice.getActivePiVoiceCall()).toBeUndefined();
    expect(calls[0]).toMatchObject({ hungUp: true, micClosed: true });
    expect(endButton(container)).toBeNull();
    unmount();
  });
}

test('on its own session the bar shows the phase and End, without naming the session', async () => {
  const { driver } = fakePiVoiceDriver();
  await voice.startPiVoiceCallFor('org', '/p', driver, { onEnded() {}, onFailed() {} });
  const { container, unmount } = await view('org');
  expect(endButton(container)).not.toBeNull();
  expect(container.textContent).toContain('Connecting');
  expect(container.textContent).not.toContain('org session');
  unmount();
});

test('every app shell that can hold a call mounts the call bar above its gates, and nothing gated mounts it', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  const app = await source('../../App.tsx');
  // Both shells: the main app (beside MainLayout, not inside it) and the embedded session chat.
  expect(app.match(/<PiVoiceCallBar \/>/g)).toHaveLength(2);
  expect(app.indexOf('<PiVoiceCallBar />', app.indexOf('<MainLayout />'))).toBeGreaterThan(app.indexOf('<MainLayout />'));
  // The dedicated mobile app (renderMobileApp → MobileApp) is its own tree: beside MobileShell, not inside it.
  const mobile = await source('../../apps/MobileApp.tsx');
  expect(mobile.match(/<PiVoiceCallBar \/>/g)).toHaveLength(1);
  expect(mobile.indexOf('<PiVoiceCallBar />')).toBeGreaterThan(mobile.indexOf('<MobileShell '));
  // Shells where no call can start mount nothing: VS Code and the desktop mini chat (supportsPiVoice is false).
  for (const shell of ['../../apps/VSCodeApp.tsx', '../../apps/ElectronMiniChatApp.tsx']) {
    expect(await source(shell)).not.toContain('PiVoiceCallBar');
  }
  for (const gated of ['./composer/ui/ComposerFooter.tsx', './ChatContainer.tsx', './ChatInput.tsx', '../layout/MainLayout.tsx']) {
    expect(await source(gated)).not.toContain('PiVoiceCallBar');
  }
});
