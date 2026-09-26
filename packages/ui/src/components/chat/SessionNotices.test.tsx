import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { Event, Message } from '@opencode-ai/sdk/v2/client';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { registerPendingSteer, reloadPendingSteersForTest } from '@/sync/pending-steers';
import { reloadSteerOutcomesForTest, useSteerOutcomes } from '@/sync/steer-outcomes';
import { createEventRoutingIndex, handleEvent } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { SessionNotices } from './SessionNotices';

// Review P2 on openchamber#238: a steered message's outcome stays in the chat, with its text, whatever the failed-turn
// notice does (busy, newer messages, an assistant error), and every outcome is shown, not only the latest.
const DIRECTORY = '/repo';
const SESSION = 'ses_org';
const globals = globalThis as unknown as Record<string, unknown> & {
  __openchamber_sync_context__?: React.Context<unknown>;
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
};
const syncContext = globals.__openchamber_sync_context__!;
const syncRuntimeContext = globals.__openchamber_sync_runtime_context__!;

let win: Window;
let root: Root;
let container: HTMLElement;
let children: ChildStoreManager;
let previous: Map<string, PropertyDescriptor | undefined>;

const store = () => children.getChild(DIRECTORY)!;
const text = () => container.textContent ?? '';
const assistant = (id: string, time: { created: number; completed?: number }, error?: unknown) =>
  ({ id, role: 'assistant', sessionID: SESSION, time, ...(error ? { error } : {}) }) as unknown as Message;
const user = (id: string, created: number) => ({ id, role: 'user', sessionID: SESSION, time: { created } }) as unknown as Message;
const settle = (items: Array<[string, string, string]>) => act(async () => {
  for (const [messageID, textSent] of items) {
    registerPendingSteer({ runtimeKey: getRuntimeKey(), directory: DIRECTORY, sessionID: SESSION, messageID, text: textSent });
  }
  for (const [messageID, , outcome] of items) {
    handleEvent('global', { type: 'smarty.prompt.outcome', properties: { sessionID: SESSION, messageID, outcome } } as unknown as Event,
      children, createEventRoutingIndex(), getRuntimeKey());
  }
  await Promise.resolve();
});
const setSession = (patch: Partial<State>) => act(async () => { store().setState(patch); });

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true };
  previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  reloadPendingSteersForTest();
  reloadSteerOutcomesForTest();
  children = new ChildStoreManager();
  children.ensureChild(DIRECTORY, { bootstrap: false }).setState({ status: 'complete',
    session: [{ id: SESSION, directory: DIRECTORY, title: 'org', time: { created: 1, updated: 1 }, version: '1' }] } as Partial<State>);
  container = win.document.createElement('div') as unknown as HTMLElement;
  root = createRoot(container);
  const system = { childStores: children, messageLoader: {}, sdk: {}, runtimeKey: getRuntimeKey(), directory: DIRECTORY };
  const runtime = { ...system, currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined } };
  await act(async () => root.render(
    <I18nProvider>
      <syncContext.Provider value={system}>
        <syncRuntimeContext.Provider value={runtime}>
          <SessionNotices sessionId={SESSION} directory={DIRECTORY} />
        </syncRuntimeContext.Provider>
      </syncContext.Provider>
    </I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  children.disposeAll();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
  }
  await win.happyDOM.close();
});

test('an outcome while the agent works stays in the chat after that turn completes', async () => {
  await setSession({ session_status: { [SESSION]: { type: 'busy' } },
    message: { [SESSION]: [user('u1', 1), assistant('a1', { created: 2 })] } } as Partial<State>);
  await settle([['m1', 'what changed today?', 'unconfirmed']]);
  expect(text()).toContain('Not confirmed:');
  expect(text()).toContain('what changed today?');
  await setSession({ session_status: { [SESSION]: { type: 'idle' } },
    message: { [SESSION]: [user('u1', 1), assistant('a1', { created: 2, completed: Date.now() + 60_000 })] } } as Partial<State>);
  expect(text()).toContain('what changed today?');
});

test('an outcome after an assistant error is shown, not hidden by that error', async () => {
  await setSession({ session_status: { [SESSION]: { type: 'idle' } },
    message: { [SESSION]: [user('u1', 1), assistant('a1', { created: 2, completed: 3 }, { name: 'APIError', data: { message: 'x' } })] } } as Partial<State>);
  await settle([['m1', 'draft a marketing plan', 'not-delivered']]);
  expect(text()).toContain('Not delivered:');
  expect(text()).toContain('draft a marketing plan');
});

test('two messages settled together both stay, each with its text; dismissing one keeps the other, and a reload keeps it', async () => {
  await setSession({ session_status: { [SESSION]: { type: 'busy' } } } as Partial<State>);
  await settle([['m1', 'first steer', 'not-delivered'], ['m2', 'second steer', 'unconfirmed']]);
  expect(text()).toContain('first steer');
  expect(text()).toContain('second steer');
  const dismiss = container.querySelectorAll('button[aria-label="Dismiss"]');
  expect(dismiss).toHaveLength(2);
  await act(async () => { (dismiss[0] as HTMLButtonElement).click(); });
  expect(text()).not.toContain('first steer');
  expect(text()).toContain('second steer');
  await act(async () => { reloadSteerOutcomesForTest(); });
  expect(useSteerOutcomes.getState().items.map(item => item.text)).toEqual(['second steer']);
  expect(text()).toContain('second steer');
});
