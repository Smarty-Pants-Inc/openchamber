import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { createEventRoutingIndex, handleEvent, useSessionMessageRecords } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { areRenderRelevantMessagesEqual } from './message/renderCompare';
import { UnsavedLabel } from './UnsavedLabel';

// Slice 1 L1 (code-voice's pre-check ask): the gateway's info.metadata.smartyCodeUnsaved reaches a mounted row from a
// history page and from a live update, and the label goes once the row is saved, through the same memo comparator the
// chat rows use (a metadata-only change must re-render).
const DIRECTORY = '/repo';
const SESSION = 's1';
const globals = globalThis as unknown as Record<string, unknown> & {
  __openchamber_sync_context__?: React.Context<unknown>;
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
};
const view = `ov2_${'d'.repeat(64)}`;
const record = (revision: number, unsaved: boolean) => ({
  info: { id: 'm1', sessionID: SESSION, role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop',
    metadata: { ...(unsaved ? { smartyCodeUnsaved: true } : {}), smartyCodeRevision: revision } },
  parts: [{ id: 'p1', messageID: 'm1', sessionID: SESSION, type: 'text', text: 'hello' }],
});

const Row = React.memo(({ message }: { message: { info: unknown; parts: unknown[] } }) => (
  <div data-row><UnsavedLabel info={message.info} /></div>
), (left, right) => areRenderRelevantMessagesEqual(left.message as never, right.message as never));
const Rows = () => {
  const records = useSessionMessageRecords(SESSION, DIRECTORY);
  return <>{records.map((message) => <Row key={message.info.id} message={message as never} />)}</>;
};

let win: Window;
let root: Root;
let container: HTMLElement;
let children: ChildStoreManager;
let loader: SessionMessageLoader;
let previous: Map<string, PropertyDescriptor | undefined>;

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  children = new ChildStoreManager();
  children.ensureChild(DIRECTORY, { bootstrap: false }).setState({ status: 'complete',
    session: [{ id: SESSION, directory: DIRECTORY, title: 'org', time: { created: 1, updated: 1 }, version: '1' }] } as Partial<State>);
  const sdk = { session: { messages: async () => ({ data: [record(1, true)],
    response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) }) } };
  loader = new SessionMessageLoader(children, { sdk: sdk as never, runtimeKey: getRuntimeKey() });
  container = win.document.createElement('div') as unknown as HTMLElement;
  root = createRoot(container);
  const system = { childStores: children, messageLoader: loader, sdk: {}, runtimeKey: getRuntimeKey(), directory: DIRECTORY };
  const runtime = { ...system, currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined } };
  const Sync = globals.__openchamber_sync_context__!;
  const Runtime = globals.__openchamber_sync_runtime_context__!;
  await act(async () => root.render(
    <I18nProvider><Sync.Provider value={system}><Runtime.Provider value={runtime}><Rows /></Runtime.Provider></Sync.Provider></I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  loader.dispose();
  children.disposeAll();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
  }
  await win.happyDOM.close();
});

const labels = () => container.querySelectorAll('[data-row] span').length;
const live = (revision: number, unsaved: boolean) => act(async () => {
  handleEvent(DIRECTORY, { type: 'message.updated', properties: { info: record(revision, unsaved).info } } as unknown as Event,
    children, createEventRoutingIndex(), getRuntimeKey());
});

test('the label shows from a history page, goes when a live update saves the row, and returns when a newer update un-saves it', async () => {
  await act(async () => { await loader.ensure({ directory: DIRECTORY, sessionID: SESSION }); });
  expect(container.querySelectorAll('[data-row]')).toHaveLength(1);
  expect(container.textContent).toContain('unsaved');
  expect(labels()).toBe(1);
  await live(2, false);
  expect(labels()).toBe(0);
  await live(3, true);
  expect(labels()).toBe(1);
  // An older buffered update cannot clear the newer state.
  await live(2, false);
  expect(labels()).toBe(1);
});
