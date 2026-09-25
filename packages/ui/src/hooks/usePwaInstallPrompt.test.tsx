import React, { act } from 'react';
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

// smarty-code#126 F7 (d): the install toast showed on every load. It now shows at most once per browser.
const shown: string[] = [];
// Spread the real modules so this file's mocks do not break other test files in the same run.
const [realUi, realDesktop, realDetection, realI18n] = await Promise.all([
  import('@/components/ui'), import('@/lib/desktop'), import('@/hooks/usePwaDetection'), import('@/lib/i18n')]);
mock.module('@/components/ui', () => ({ ...realUi, toast: {
  info: (message: string) => { shown.push(message); return shown.length; },
  success: () => undefined, dismiss: () => undefined,
} }));
mock.module('@/lib/desktop', () => ({ ...realDesktop, isWebRuntime: () => true }));
mock.module('@/hooks/usePwaDetection', () => ({ ...realDetection, usePwaDetection: () => ({ browserTab: true }) }));
mock.module('@/lib/i18n', () => ({ ...realI18n, useI18n: () => ({ t: (key: string) => key }) }));

const NAMES = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
// One browser for the whole file: its localStorage is what must persist across page loads.
const happy = new Window({ url: 'https://code.example.test' });
const values = { window: happy, document: happy.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { usePwaInstallPrompt } = await import('./usePwaInstallPrompt');

function Probe() {
  usePwaInstallPrompt();
  return null;
}

/** One page load in a new tab: mount, let the browser offer install (optionally report an install), unmount. */
async function load(options: { installed?: boolean } = {}) {
  happy.sessionStorage.clear();
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  const offer = new happy.Event('beforeinstallprompt', { cancelable: true });
  Object.assign(offer, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  act(() => { happy.dispatchEvent(offer); });
  if (options.installed) act(() => { happy.dispatchEvent(new happy.Event('appinstalled')); });
  act(() => root.unmount());
}

beforeEach(() => {
  shown.length = 0;
  happy.localStorage.clear();
});

test('the install toast shows on the first load only, across tabs and restarts', async () => {
  await load();
  await load();
  await load();
  expect(shown).toEqual(['pwa.installPrompt.description']);
});

test('after the app is installed the toast never returns', async () => {
  happy.localStorage.setItem('pwa-install-toast-dismissed', 'true');
  await load();
  expect(shown).toHaveLength(0);
  happy.localStorage.clear();
  await load({ installed: true });
  shown.length = 0;
  await load();
  expect(shown).toHaveLength(0);
});
