import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from '@/components/chat/composer/submit/__tests__/nativeComposer.fixture';
import { deferred, directory as A, session, acceptedView } from '@/sync/native-draft-fixture';
import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readSelectedSessionOwner, useSelectedSessionOwner } from '@/sync/selected-session-owner';
import type { useSyncRuntime } from '@/sync/sync-context';

const { ChatInput } = await import('@/components/chat/ChatInput');
type Runtime = ReturnType<typeof useSyncRuntime>;
const globals: typeof globalThis & { __openchamber_sync_runtime_context__?: React.Context<Runtime | null> } = globalThis;
const B = '/native-project-b', target = { sessionID: session.id, directory: B };
const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const row = (directory: string, generation = 'g1') => ({ ...session, directory,
  ordinary: { ...ordinary, generation }, nativeRuntime: 'ordinary', herdrState: 'idle', herdrPaneLive: true });
const freshView = `ov2_${'b'.repeat(64)}`;
const page = (view = acceptedView) => Response.json([{
  info: { id: 'retained-user', sessionID: session.id, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } },
  parts: [{ id: 'retained-text', messageID: 'retained-user', sessionID: session.id, type: 'text', text: 'Retained history' }],
}], { headers: { 'x-smarty-ordinary-view': view } });
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreFetch = () => {};
afterEach(async () => { restoreFetch(); restoreFetch = () => {}; await mounted?.dispose(); mounted = undefined; });
const tick = () => act(async () => { await sleep(10); });
async function settle(matches: () => boolean) {
  for (let turn = 0; turn < 400 && !matches(); turn++) await tick();
  expect(matches()).toBe(true);
}
function OwnerComposer() {
  const directory = useSessionUIStore(state => state.currentSessionDirectory);
  const owner = useSelectedSessionOwner(session.id, directory ?? undefined, false);
  return <ChatInput ownerPending={owner?.status === 'checking' || owner?.status === 'unknown'} />;
}
async function establish() {
  // Mount the actual composer under the same provider-owned owner hook and pending gate as ChatContainer.
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, f => {
    const Context = globals.__openchamber_sync_runtime_context__;
    if (!Context) throw new Error('Sync runtime context missing');
    const value: Runtime = { childStores: f.children, messageLoader: f.loader, sdk: opencodeClient.getSdkClient(), runtimeKey: f.runtimeA,
      currentDirectory: { get: () => useSessionUIStore.getState().currentSessionDirectory ?? A, subscribe: listener => useSessionUIStore.subscribe(listener) } };
    return <Context.Provider value={value}><OwnerComposer /></Context.Provider>;
  }, f => {
    window.innerWidth = 390; window.innerHeight = 844;
    f.handlers.history = async () => page();
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row(A)] });
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
      managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }],
      managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }, { id: 'b', path: B, addedAt: 0, lastOpenedAt: 0 }] });
    useGlobalSessionsStore.getState().applySnapshot([], []);
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, selectedManagedOwner: null,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const previous = globalThis.fetch;
  const controls = { detail: async (request: Request): Promise<Response> =>
    Response.json(row(new URL(request.url).searchParams.get('directory') ?? B)) };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === 'synthetic.invalid' && request.method === 'GET' && url.pathname.endsWith(`/session/${session.id}`)) {
      c.requests.push(request); return controls.detail(request);
    }
    return previous(input, init);
  };
  restoreFetch = () => { globalThis.fetch = previous; };
  await c.replace('Explicit user Send only');
  await act(async () => useGlobalSessionsStore.getState().upsertSession(row(B)));
  await settle(() => readSelectedSessionOwner(session.id, B)?.status === 'live');
  await act(async () => useUIStore.setState({ isMobile: true, isExpandedInput: false }));
  const send = () => {
    const button = c.dom.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    if (!button) throw new Error('Actual mobile Send button missing');
    return button;
  };
  expect(send().disabled).toBe(false);
  expect(c.children.getState(B)?.message[session.id]).toHaveLength(1);
  const owners = () => c.requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${session.id}`));
  const histories = () => c.requests.filter(request => new URL(request.url).pathname.endsWith('/message'));
  return { ...c, controls, send, owners, histories };
}

test('quiet transport recovery restores fresh writable history and mounted Send without reconnect, catalog update or replay', async () => {
  const c = await establish(), scope = captureRuntimeRequestScope(), catalog = useProjectsStore.getState().managedRows;
  const owners = c.owners().length, histories = c.histories().length;
  let connectionChanges = 0;
  const stop = useConfigStore.subscribe((next, previous) => { if (next.isConnected !== previous.isConnected) connectionChanges++; });
  try {
    c.handlers.history = async () => { throw new TypeError('Failed to fetch'); };
    await act(async () => { await c.loader.refreshOrdinaryView(target); });
    expect(c.histories()).toHaveLength(histories + 3);
    expect(c.loader.getSnapshot(target)).toMatchObject({ status: 'error', resolved: false });
    expect(c.loader.getSendableOrdinaryView(target, c.runtimeA)).toBeUndefined();
    expect(c.children.getState(B)?.message[session.id]).toHaveLength(1);
    expect(c.send().disabled).toBe(true);
    await c.submit(); expect(c.prompts()).toHaveLength(0); // Dispatch is fenced too, not only the button.
    c.handlers.history = async () => page(freshView);
    await settle(() => readSelectedSessionOwner(session.id, B)?.status === 'live' && !c.send().disabled);
    expect(c.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false, ordinaryView: freshView });
    expect(c.loader.getSendableOrdinaryView(target, c.runtimeA)).toBe(freshView);
    expect(c.owners()).toHaveLength(owners + 2); expect(c.histories()).toHaveLength(histories + 4);
    expect(c.prompts()).toHaveLength(0); expect(c.creates()).toHaveLength(0);
    expect(connectionChanges).toBe(0); expect(useConfigStore.getState().isConnected).toBe(true);
    expect(useProjectsStore.getState().managedRows).toBe(catalog); expect(isRuntimeRequestScopeCurrent(scope)).toBe(true);
    await act(async () => { c.send().click(); await sleep(20); });
    await settle(() => c.prompts().length === 1);
    expect(c.prompts()[0].headers.get('x-smarty-ordinary-view')).toBe(freshView);
    expect(new URL(c.prompts()[0].url).searchParams.get('directory')).toBe(B);
  } finally { stop(); }
}, 15_000);

test('persistent quiet transport failure spends one replacement operation and then stops unknown with Send fenced', async () => {
  const c = await establish(), owners = c.owners().length, histories = c.histories().length;
  c.handlers.history = async () => { throw new TypeError('Failed to fetch'); };
  await act(async () => { await c.loader.refreshOrdinaryView(target); });
  await settle(() => readSelectedSessionOwner(session.id, B)?.status === 'unknown');
  expect(c.owners()).toHaveLength(owners + 2); expect(c.histories()).toHaveLength(histories + 6);
  expect(c.send().disabled).toBe(true);
  await act(async () => { await sleep(2200); });
  expect(c.owners()).toHaveLength(owners + 2); expect(c.histories()).toHaveLength(histories + 6);
  await c.submit(); expect(c.prompts()).toHaveLength(0);
}, 15_000);

test('quiet recovery rejects a held stale native completion without overwriting the new generation or granting Send', async () => {
  const c = await establish(), owners = c.owners().length, histories = c.histories().length;
  c.handlers.history = async () => { throw new TypeError('Failed to fetch'); };
  await act(async () => { await c.loader.refreshOrdinaryView(target); });
  const held = deferred<Response>();
  let scoped: Request | undefined;
  c.controls.detail = async request => {
    if (new URL(request.url).searchParams.has('directory')) { scoped = request; return held.promise; }
    return Response.json(row(B));
  };
  await settle(() => scoped !== undefined);
  const child = c.children.ensureChild(B, { bootstrap: false });
  // Fail the current replacement strict read; the old native reply must not become the new proof.
  c.controls.detail = async () => { throw new TypeError('Failed to fetch'); };
  await act(async () => child.setState({ session: [row(B, 'g2')], sessionEventRevision: { [session.id]: 7 } }));
  expect(readSelectedSessionOwner(session.id, B)?.status).not.toBe('live');
  c.handlers.history = async () => page(freshView);
  await act(async () => { held.resolve(Response.json(row(B))); });
  await settle(() => readSelectedSessionOwner(session.id, B)?.status === 'unknown');
  expect(readOrdinaryModel(child.getState().session[0])?.generation).toBe('g2');
  expect(c.send().disabled).toBe(true); expect(c.loader.getSendableOrdinaryView(target, c.runtimeA)).toBeUndefined();
  expect(c.owners()).toHaveLength(owners + 3); expect(c.histories()).toHaveLength(histories + 3);
  await c.submit(); expect(c.prompts()).toHaveLength(0);
}, 15_000);
