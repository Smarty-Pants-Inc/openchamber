import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useStartRetry } from './useStartRetry';

// smarty-code#302: the mobile browser layout stayed on "Unable to reach server" after a start whose health probe
// failed under load. It now retries the start until it connects.
const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const initial = useConfigStore.getState();
afterAll(async () => {
  useConfigStore.setState(initial, true);
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

test('a failed start is retried with backoff until the server answers; then retries stop', async () => {
  let calls = 0;
  useConfigStore.setState({ isInitialized: false, isConnected: false, initializeApp: async () => {
    calls += 1;
    if (calls === 2) useConfigStore.setState({ isInitialized: true, isConnected: true }); // the second retry succeeds
  } });
  const Probe = () => { useStartRetry(true, 0); return null; };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  await act(async () => root.render(<Probe />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(calls).toBe(1); // after 1 s
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(calls).toBe(2); // after 2 s more, and it connected
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 4100)); });
  expect(calls).toBe(2); // no more retries once connected
  await act(async () => root.unmount());
}, 12_000);

test('native apps and a started app do not retry', async () => {
  let calls = 0;
  useConfigStore.setState({ isInitialized: false, isConnected: false, initializeApp: async () => { calls += 1; } });
  const Native = () => { useStartRetry(false, 0); return null; };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  await act(async () => root.render(<Native />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(calls).toBe(0);
  await act(async () => root.unmount());
});
