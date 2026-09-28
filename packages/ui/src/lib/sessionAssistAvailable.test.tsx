import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { useProjectsStore } from '@/stores/useProjectsStore';

// smarty-code#729: under Smarty Code (a managed catalog) session assist cannot work (no small model), so the hook shows
// no suggestion or recap and the Chat settings do not offer them; stock OpenChamber is unchanged.
const assist = { recap: 'The recap.', suggestion: 'Next, run the tests.', forMessageID: 'a1', generatedAt: 1 };
const session = { id: 's', slug: 's', projectID: 'p', directory: '/', title: 't', version: '1', time: { created: 0, updated: 0 },
  ...{ metadata: { openchamber: { assist } } } } satisfies Omit<Session, never> & object;
const reply = { id: 'a1', sessionID: 's', role: 'assistant', time: { created: 1, completed: 2 } };
const store = { getState: () => ({ message: { s: [reply] } }), subscribe: () => () => {} };
mock.module('@/sync/sync-context', () => ({ useDirectoryStore: () => store, useSession: () => session, useSessionStatus: () => ({ type: 'idle' }) }));
const { useSessionAssistState } = await import('@/hooks/useSessionAssist');

async function render(node: () => React.ReactNode) {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.createElement('div')); // The global document is happy-dom's (defined just above).
  try { await act(async () => root.render(node())); } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
}

test('stock OpenChamber shows the assist; Smarty Code (a managed catalog) shows none', async () => {
  let suggestion: string | null = 'unset';
  const Probe = () => { suggestion = useSessionAssistState('s').suggestion; return null; };
  useProjectsStore.setState({ managedCatalogAdmitted: false });
  await render(() => <Probe />);
  expect(suggestion).toBe('Next, run the tests.');
  useProjectsStore.setState({ managedCatalogAdmitted: true });
  await render(() => <Probe />);
  expect(suggestion).toBeNull();
});

test('the Chat settings offer the recap and suggestion only when assist is available', async () => {
  // OpenChamberPage pulls in Vite-only modules (import.meta.glob), so its wiring is checked in its source: the Chat
  // section's list takes 'sessionAssist' only from the availability hook, and every other entry stays.
  const source = await readFile(new URL('../components/sections/openchamber/OpenChamberPage.tsx', import.meta.url), 'utf8');
  const chat = source.slice(source.indexOf('const ChatSectionContent'), source.indexOf('const ChatSectionContent') + 1200);
  expect(chat).toContain('const sessionAssistAvailable = useSessionAssistAvailable();');
  expect(chat).toContain("...(sessionAssistAvailable ? ['sessionAssist' as const] : []),");
  expect(/^\s*'sessionAssist',$/m.test(chat)).toBe(false);
  expect(chat).toContain("'sessionGoal',");
  expect((source.match(/'sessionAssist'/g) ?? []).length).toBe(1); // No other section offers it.
});
