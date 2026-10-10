import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2';

// smarty-code#1407: the Timeline lists one session's user messages. By default that is the current session (the chat's
// own use); the Feed passes its org agent session, which can live in another directory, as `sessionId` and `directory`.
const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
  getComputedStyle: win.getComputedStyle.bind(win), matchMedia: win.matchMedia.bind(win),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  // No server: a store this reads may ask for its data; every request fails, as an offline page would.
  fetch: async () => new Response('{}', { status: 404 }) };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });

const { TimelineDialog } = await import('./TimelineDialog');
const { I18nProvider } = await import('@/lib/i18n');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader } = await import('@/sync/session-message-loader');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

const CHAT = { directory: '/repo', sessionID: 'ses_chat', text: 'Fix the login bug' };
const ORG = { directory: '/org', sessionID: 'ses_org', text: 'What is waiting for me?' };
const history = ({ sessionID, text }: { sessionID: string; text: string }) => [{
  info: { id: `${sessionID}_u1`, sessionID, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } satisfies Message,
  parts: [{ id: `${sessionID}_t1`, sessionID, messageID: `${sessionID}_u1`, type: 'text', text } satisfies Part],
}];
const children = new ChildStoreManager();
for (const { directory, sessionID } of [CHAT, ORG]) {
  children.ensureChild(directory, { bootstrap: false }).setState({ status: 'complete',
    session: [{ id: sessionID, slug: sessionID, projectID: 'p', directory, title: sessionID, time: { created: 1, updated: 1 }, version: '1' }] });
}
const sdk = { session: { messages: async ({ sessionID }: { sessionID: string }) => ({
  data: history(sessionID === ORG.sessionID ? ORG : CHAT), response: new Response(null) }) } };
// SAFETY: the loader calls only session.messages, which the fake answers in the SDK's shape.
const loader = new SessionMessageLoader(children, { sdk: sdk as never, runtimeKey: getRuntimeKey() });
const system = { childStores: children, messageLoader: loader, sdk: {}, runtimeKey: getRuntimeKey(), directory: CHAT.directory };
const runtime = { ...system, currentDirectory: { get: () => CHAT.directory, subscribe: () => () => undefined } };
// sync-context publishes its two React contexts on globalThis (UnsavedLabel.dom.test.tsx provides them the same way).
const Sync: React.Context<unknown> = Object.getOwnPropertyDescriptor(globalThis, '__openchamber_sync_context__')?.value;
const SyncRuntime: React.Context<unknown> = Object.getOwnPropertyDescriptor(globalThis, '__openchamber_sync_runtime_context__')?.value;

afterAll(async () => {
  loader.dispose();
  children.disposeAll();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

const shown = async (dialog: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider><Sync.Provider value={system}><SyncRuntime.Provider value={runtime}>{dialog}</SyncRuntime.Provider></Sync.Provider></I18nProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  const text = document.body.textContent ?? '';
  await act(async () => root.unmount());
  host.remove();
  return text;
};

test('the Timeline lists the current session by default, and the session it is given otherwise', async () => {
  await act(async () => {
    await loader.ensure({ directory: CHAT.directory, sessionID: CHAT.sessionID });
    await loader.ensure({ directory: ORG.directory, sessionID: ORG.sessionID });
  });
  useSessionUIStore.setState({ currentSessionId: CHAT.sessionID });

  const chat = await shown(<TimelineDialog open onOpenChange={() => undefined} />);
  expect(chat).toContain(CHAT.text);
  expect(chat).not.toContain(ORG.text);

  const feed = await shown(<TimelineDialog open onOpenChange={() => undefined} sessionId={ORG.sessionID} directory={ORG.directory} />);
  expect(feed).toContain(ORG.text);
  expect(feed).not.toContain(CHAT.text);
});
