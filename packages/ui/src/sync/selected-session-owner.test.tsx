import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { setSyncRefs } from './sync-refs';
import { setActionRefs } from './session-actions';
import { useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { refreshRuntimeUrlAuthToken, setRuntimeBearerToken } from '@/lib/runtime-auth';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { deferred } from '@/lib/runtime-isolation-fixture';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { checkSelectedSessionOwner, readSelectedSessionOwner, useSelectedSessionOwner } from './selected-session-owner';
import type { useSyncRuntime } from './sync-context';

const A = '/admitted/source', B = '/admitted/destination', id = 'same-native-session';
const view = `ov2_${'d'.repeat(64)}`;
const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const row = (directory: string, ended = false): Session => ({ id, directory, slug: id, projectID: directory, title: 'test', version: '1',
  time: { created: 1, updated: 1 }, ...{ ordinary, nativeRuntime: 'ordinary', herdrState: ended ? 'ended' : 'idle', herdrPaneLive: !ended } });
let stores: ChildStoreManager, loader: SessionMessageLoader;
let detail: (request: Request) => Promise<Response>;
let history: () => Promise<Response>;
const requests: Request[] = [];
const originalFetch = globalThis.fetch;
const initialUI = useSessionUIStore.getState(), initialProjects = useProjectsStore.getState(), initialGlobal = useGlobalSessionsStore.getState();
function page(readOnly = false) { return Response.json([], { headers: readOnly ? { 'x-smarty-read-only': 'true' } : { 'x-smarty-ordinary-view': view } }); }

beforeEach(async () => {
  requests.length = 0;
  detail = async () => Response.json(row(B));
  history = async () => page();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === '/auth/url-token') return Response.json({ token: 'fixture', expiresAt: Date.now() + 60000 });
    requests.push(request);
    if (path.endsWith('/message')) return history();
    if (path.endsWith(`/session/${id}`)) return detail(request);
    if (path.endsWith('/client-error')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected controlled request: ${request.method} ${path}`);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://owner.invalid', runtimeKey: 'owner-test', clientToken: 'fixture-token' });
  await refreshRuntimeUrlAuthToken();
  opencodeClient.setDirectory(A);
  stores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), stores, A);
  setActionRefs(opencodeClient.getSdkClient(), stores, () => A);
  loader = new SessionMessageLoader(stores, { sdk: opencodeClient.getSdkClient(), runtimeKey: 'owner-test' });
  setImperativeSessionMessageLoader(loader);
  stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)], message: { [id]: [] } });
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }], managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }, { id: 'b', path: B, addedAt: 0, lastOpenedAt: 0 }] });
  useGlobalSessionsStore.getState().upsertSession(row(B));
  useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: A, selectedManagedOwner: null });
});
afterEach(() => {
  setImperativeSessionMessageLoader(null); loader.dispose(); stores.disposeAll();
  useSessionUIStore.setState(initialUI, true); useProjectsStore.setState(initialProjects, true); useGlobalSessionsStore.setState(initialGlobal, true);
  globalThis.fetch = originalFetch; opencodeClient.setDirectory(undefined);
});

test('real selected path blocks false ended and Send, shares one unqualified read, adopts owner only with fresh accepted destination view', async () => {
  const response = deferred<Response>(), newest = deferred<Response>();
  detail = async request => new URL(request.url).searchParams.has('directory') ? Response.json(row(B)) : response.promise;
  history = () => newest.promise;
  expect(readSelectedSessionOwner(id, A)?.status).toBe('checking');
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
  const first = checkSelectedSessionOwner(id, A);
  expect(checkSelectedSessionOwner(id, A)).toBe(first);
  response.resolve(Response.json(row(B)));
  for (let tick = 0; tick < 25 && !requests.some(request => request.url.includes('/message')); tick++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('checking');
  expect(readOpenOrdinaryState(id, B, false)?.model).toBeNull();
  newest.resolve(page()); await first;
  expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
  expect(readOpenOrdinaryState(id, B, false)?.model?.name).toBe('M');
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
  expect(useSessionUIStore.getState().getDirectoryForSession(id)).toBe(B);
  expect(useDirectoryStore.getState().currentDirectory).toBe(B);
  expect(useProjectsStore.getState().activeProjectId).toBe('b');
  expect(opencodeClient.getDirectory()).toBe(B);
  loader.invalidateOrdinaryView({ sessionID: id, directory: B });
  expect(readOpenOrdinaryState(id, B, false)?.model?.name).toBe('M'); // healthy send's revocation retains this branch
  // A late losing child snapshot cannot take mutation routing away from the fresh owner.
  stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)] });
  expect(useSessionUIStore.getState().getDirectoryForSession(id)).toBe(B);
  const reads = requests.filter(request => request.method === 'GET');
  expect(reads).toHaveLength(3);
  expect(new URL(reads[0].url).searchParams.has('directory')).toBe(false);
  expect(reads[0].headers.has('x-opencode-directory')).toBe(false);
  expect(new URL(reads[1].url).searchParams.get('directory')).toBe(B);
  expect(new URL(reads[2].url).searchParams.get('directory')).toBe(B);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('fresh explicit ended/no live pane keeps genuine ended and Send off', async () => {
  detail = async () => Response.json(row(A, true));
  await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, A)?.status).toBe('ended');
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
  expect(requests).toHaveLength(1);
});
for (const [name, response] of [
  ['missing404', () => new Response(null, { status: 404 })],
  ['project failure', () => new Response(null, { status: 503 })],
  ['missing liveness', () => Response.json({ ...row(B), herdrPaneLive: undefined })],
  ['invalid liveness', () => Response.json({ ...row(B), herdrPaneLive: 'true' })],
  ['unadmitted owner', () => Response.json(row('/outside'))],
  ['wrong session', () => Response.json({ ...row(B), id: 'another' })],
  ['stale answer', () => Response.json(row(B), { headers: { 'x-smarty-catalog-state': 'stale' } })],
] as const) test(`${name} stays unknown, not ended or writable`, async () => {
  detail = async () => response(); await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, A)?.status).toBe('unknown');
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
});
for (const change of ['selection ABA', 'catalog', 'generation', 'auth', 'runtime ABA'] as const) test(`${change} rejects late owner completion`, async () => {
  const pending = deferred<Response>(); detail = () => pending.promise;
  const check = checkSelectedSessionOwner(id, A);
  await new Promise(resolve => setTimeout(resolve, 5));
  if (change === 'selection ABA') { useSessionUIStore.setState({ currentSessionId: 'other' }); useSessionUIStore.setState({ currentSessionId: id }); }
  if (change === 'catalog') useProjectsStore.setState({ managedRows: [{ id: 'a', worktree: A }] });
  if (change === 'generation') stores.ensureChild(A, { bootstrap: false }).setState({ session: [{ ...row(A, true), ...{ ordinary: { ...ordinary, generation: 'g2' } } }] });
  if (change === 'auth') setRuntimeBearerToken('new-fixture-token');
  if (change === 'runtime ABA') {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://owner.invalid', runtimeKey: 'other', clientToken: 'fixture-token' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://owner.invalid', runtimeKey: 'owner-test', clientToken: 'fixture-token' });
  }
  pending.resolve(Response.json(row(B))); await check;
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(readSelectedSessionOwner(id, A)?.status).not.toBe('live');
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
});

test('destination generation changed between detail reads stays unknown without adoption', async () => {
  detail = async request => Response.json(new URL(request.url).searchParams.has('directory')
    ? { ...row(B), ordinary: { ...ordinary, generation: 'g2' } } : row(B));
  await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, A)?.status).toBe('unknown');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
});

test('a timed-out strict read rejects even a later live response', async () => {
  const response = deferred<Response>(); detail = () => response.promise;
  const check = checkSelectedSessionOwner(id, A);
  await check;
  // A prior selection's existing catalog retry can supersede this scope during the real ten-second wait.
  const expected = useProjectsStore.getState().managedCatalogStatus === 'ready' ? 'unknown' : 'checking';
  expect(readSelectedSessionOwner(id, A)?.status).toBe(expected);
  expect(readOpenOrdinaryState(id, A, false)?.model).toBeNull();
  response.resolve(Response.json(row(B)));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(readSelectedSessionOwner(id, A)?.status).toBe(expected);
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
}, 15_000);

test('readonly destination history never recovers composer permission', async () => {
  history = async () => page(true); await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('unknown');
  expect(readOpenOrdinaryState(id, B, false)?.model).toBeNull();
});

test('mounted selected owner hook recovers without a keystroke; healthy stock makes no owner read', async () => {
  const win = new Window({ url: 'https://owner.invalid' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const seen: string[] = [];
  const Probe = () => {
    const directory = useSessionUIStore(state => state.currentSessionDirectory);
    const owner = useSelectedSessionOwner(id, directory ?? undefined, false);
    seen.push(owner?.status ?? 'stock'); return <button disabled={owner?.status !== 'live'}>{owner?.status}</button>;
  };
  const globals: typeof globalThis & { __openchamber_sync_runtime_context__?: React.Context<ReturnType<typeof useSyncRuntime> | null> } = globalThis;
  const context = globals.__openchamber_sync_runtime_context__;
  if (!context) throw new Error('Native sync runtime context missing');
  const runtime: ReturnType<typeof useSyncRuntime> = { childStores: stores, messageLoader: loader, sdk: opencodeClient.getSdkClient(), runtimeKey: 'owner-test',
    currentDirectory: { get: () => useSessionUIStore.getState().currentSessionDirectory ?? '', subscribe: listener => useSessionUIStore.subscribe(listener) } };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => { root.render(<context.Provider value={runtime}><Probe /></context.Provider>); await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(seen).toContain('checking'); expect(seen.at(-1)).toBe('live'); expect(seen).not.toContain('ended');
    await act(async () => { useProjectsStore.setState({ managedCatalogAdmitted: false }); useSessionUIStore.setState({ selectedManagedOwner: null }); });
    expect(readSelectedSessionOwner(id, B)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await win.happyDOM.close();
  }
});
