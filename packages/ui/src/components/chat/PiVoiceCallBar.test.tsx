import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

// A live call keeps a visible End on every screen: a new draft (no session), another session
// without voice, or its own session. The bar reads only the page's call, never the view's capability.
const sessions = [{ id: 'org', title: 'org session' }];
const store = { subscribe: () => () => undefined, getState: () => ({ session: sessions }) };
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => store }));
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

async function view(viewedSessionId: string | null) {
  const happy = new Window({ url: 'https://code.example.test' });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><PiVoiceCallBar viewedSessionId={viewedSessionId} /></I18nProvider>); });
  return { container, unmount: () => act(() => root.unmount()) };
}
const endButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label="End voice call"]');

test('no call, no bar', async () => {
  const { container, unmount } = await view('org');
  expect(container.querySelectorAll('button')).toHaveLength(0);
  unmount();
});

for (const [screen, viewed] of [['a new draft', null], ['a session without voice', 'fleet-row']] as const) {
  test(`a live call keeps a working End on ${screen}`, async () => {
    const { driver, calls } = fakePiVoiceDriver();
    await voice.startPiVoiceCallFor('org', '/p', driver, { onEnded() {}, onFailed() {} });
    const { container, unmount } = await view(viewed);
    expect(container.textContent).toContain('in org session'); // Which session the call belongs to.
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
