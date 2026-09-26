import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { parseSessionStatus } from '@/sync/session-status';
import { createEventRoutingIndex, handleEvent } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { TerminalDialogNotice } from './TerminalDialogNotice';

// Slice 1 L4: an extension dialog open in Pi's terminal is shown as "answer in the terminal", from the session's own
// status events, and never answered or acknowledged from the page.
const DIRECTORY = '/repo';
const SESSION = 'ses_org';
const globals = globalThis as unknown as Record<string, unknown> & {
  __openchamber_sync_context__?: React.Context<unknown>;
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
};
let win: Window;
let root: Root;
let container: HTMLElement;
let children: ChildStoreManager;
let previous: Map<string, PropertyDescriptor | undefined>;
const requests: string[] = [];

const status = (value: Record<string, unknown>) => act(async () => {
  handleEvent(DIRECTORY, { type: 'session.status', properties: { sessionID: SESSION, status: value } } as unknown as Event,
    children, createEventRoutingIndex(), getRuntimeKey());
});
const text = () => container.textContent ?? '';

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: unknown) => { requests.push(String(input)); return new Response('{}'); } };
  previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  requests.length = 0;
  children = new ChildStoreManager();
  children.ensureChild(DIRECTORY, { bootstrap: false }).setState({ status: 'complete',
    session: [{ id: SESSION, directory: DIRECTORY, title: 'org', time: { created: 1, updated: 1 }, version: '1' }] } as Partial<State>);
  container = win.document.createElement('div') as unknown as HTMLElement;
  root = createRoot(container);
  const system = { childStores: children, messageLoader: {}, sdk: {}, runtimeKey: getRuntimeKey(), directory: DIRECTORY };
  const runtime = { ...system, currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined } };
  const Sync = globals.__openchamber_sync_context__!;
  const Runtime = globals.__openchamber_sync_runtime_context__!;
  await act(async () => root.render(
    <I18nProvider><Sync.Provider value={system}><Runtime.Provider value={runtime}>
      <TerminalDialogNotice sessionId={SESSION} directory={DIRECTORY} />
    </Runtime.Provider></Sync.Provider></I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  children.disposeAll();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
  }
  await win.happyDOM.close();
});

test('a dialog open in the terminal is shown with its title, as plain text, and goes when it closes', async () => {
  await status({ type: 'busy', ordinary: true, ordinaryTarget: null,
    ordinaryDialog: { kind: 'confirm', title: 'Deploy <b>now</b>?' } });
  expect(text()).toBe('Pi is waiting for an answer in the terminal: Deploy <b>now</b>?. Answer it there; nothing is answered from here.');
  expect(container.querySelector('b')).toBeNull();
  expect(container.querySelector('button, input, a')).toBeNull(); // Nothing here answers or acknowledges it.
  expect(requests).toEqual([]);
  await status({ type: 'busy', ordinary: true, ordinaryTarget: null, ordinaryDialog: null });
  expect(text()).toBe('');
});

test('a dialog without a title still says where to answer', async () => {
  await status({ type: 'busy', ordinary: true, ordinaryTarget: null, ordinaryDialog: { kind: 'select' } });
  expect(text()).toBe('Pi is waiting for an answer in the terminal. Answer it there; nothing is answered from here.');
});

test('an older gateway (no field) or a malformed dialog shows nothing, and the rest of the status still parses', async () => {
  await status({ type: 'busy', ordinary: true, ordinaryTarget: null });
  expect(text()).toBe('');
  await status({ type: 'busy', ordinary: true, ordinaryTarget: null, ordinaryDialog: { kind: 'wizard', title: 'x' } });
  expect(text()).toBe('');
  expect(parseSessionStatus({ type: 'busy', ordinary: true, ordinaryTarget: null, ordinaryDialog: { kind: 'wizard' } } as never))
    .toMatchObject({ type: 'busy', ordinary: true, ordinaryDialog: null });
});

test('the gateway keeps a session busy while its dialog is open; an idle status with a dialog shows nothing', async () => {
  await status({ type: 'idle', ordinary: true, ordinaryTarget: null, ordinaryDialog: { kind: 'confirm', title: 'x' } });
  expect(text()).toBe('');
});

test('a status poll that sees the dialog open, then closed while still busy, updates the notice', async () => {
  const { applySessionStatusSnapshot } = await import('@/sync/sync-context');
  const store = children.getChild(DIRECTORY)!;
  await act(async () => { applySessionStatusSnapshot(store, { [SESSION]: { type: 'busy', ordinary: true, ordinaryTarget: null,
    ordinaryDialog: { kind: 'input', title: 'Name?' } } } as never, [SESSION], 'monotonic'); });
  expect(text()).toContain('Name?');
  await act(async () => { applySessionStatusSnapshot(store, { [SESSION]: { type: 'busy', ordinary: true, ordinaryTarget: null,
    ordinaryDialog: null } } as never, [SESSION], 'monotonic'); });
  expect(text()).toBe('');
});
