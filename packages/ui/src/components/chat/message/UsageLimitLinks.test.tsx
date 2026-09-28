import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';

// smarty-net#136 L3: the usage-limit notice offers "Add credit" and "Manage plan" to the org owner only.
const owner = { owner: true, checkout: 'https://billing.smartypants.ai/checkout', portal: 'https://billing.smartypants.ai/portal' };
const member = { owner: false };
let answer: typeof owner | typeof member = member;
let calls = 0;
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => { calls += 1; return Response.json(answer); } }));
const { resetBillingForTests } = await import('@/lib/billingLinks');
const store = createStore(() => ({ message: { s: [{ id: 'a1', role: 'assistant', error: { name: 'SmartyLimitError', data: { message: 'Limit used up.' } } },
  { id: 'a2', role: 'assistant', error: { name: 'APIError', data: { message: '503' } } }] } }));
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => store }));
const { UsageLimitLinks } = await import('./UsageLimitLinks');

async function html(node: React.ReactNode) {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = document.createElement('div'); // The global document is happy-dom's (defined just above).
  const root = createRoot(host);
  try {
    await act(async () => root.render(node));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return host.innerHTML;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
}

test('the org owner sees Add credit and Manage plan under the usage-limit notice', async () => {
  resetBillingForTests(); answer = owner;
  const out = await html(<UsageLimitLinks sessionId="s" messageId="a1" />);
  expect(out).toContain('href="https://billing.smartypants.ai/checkout"'); expect(out).toContain('Add credit');
  expect(out).toContain('href="https://billing.smartypants.ai/portal"'); expect(out).toContain('Manage plan');
});

test('a member sees no billing link; other errors never show links nor ask', async () => {
  resetBillingForTests(); answer = member;
  expect(await html(<UsageLimitLinks sessionId="s" messageId="a1" />)).toBe('');
  resetBillingForTests(); calls = 0; answer = owner;
  expect(await html(<UsageLimitLinks sessionId="s" messageId="a2" />)).toBe('');
  expect(calls).toBe(0);
});
