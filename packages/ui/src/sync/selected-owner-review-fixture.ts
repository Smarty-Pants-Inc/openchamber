import { afterEach, beforeEach } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { setSyncRefs } from './sync-refs';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { ensureTestWebLocks } from './test-web-locks';

export const A = '/admitted/source', B = '/admitted/destination', id = 'same-native-session';
export const view = `ov2_${'d'.repeat(64)}`;
export const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
export const row = (directory: string, ended = false): Session => ({ id, directory, slug: id, projectID: directory, title: 'test', version: '1',
  time: { created: 1, updated: 1 }, ...{ ordinary, nativeRuntime: 'ordinary', herdrState: ended ? 'ended' : 'idle', herdrPaneLive: !ended } });
let stores: ChildStoreManager, loader: SessionMessageLoader;
let detail: (request: Request) => Promise<Response>;
let history: () => Promise<Response>;
export const requests: Request[] = [];
const originalFetch = globalThis.fetch;
const initialUI = useSessionUIStore.getState(), initialProjects = useProjectsStore.getState(), initialGlobal = useGlobalSessionsStore.getState(), initialConfig = useConfigStore.getState();
function page(readOnly = false) { return Response.json([], { headers: readOnly ? { 'x-smarty-read-only': 'true' } : { 'x-smarty-ordinary-view': view } }); }

beforeEach(async () => {
  ensureTestWebLocks();
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
  setOptimisticRefs(input => loader.optimisticAdd({ ...input, directory: input.directory ?? A }), input => loader.optimisticRemove({ ...input, directory: input.directory ?? A }), input => loader.optimisticConfirm({ ...input, directory: input.directory ?? A }));
  useConfigStore.setState({ isConnected: true });
  stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)], message: { [id]: [] } });
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }], managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }, { id: 'b', path: B, addedAt: 0, lastOpenedAt: 0 }] });
  useGlobalSessionsStore.getState().upsertSession(row(B));
  useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: A, selectedManagedOwner: null });
});
afterEach(() => {
  setImperativeSessionMessageLoader(null); loader.dispose(); stores.disposeAll();
  useSessionUIStore.setState(initialUI, true); useProjectsStore.setState(initialProjects, true); useGlobalSessionsStore.setState(initialGlobal, true);
  useConfigStore.setState(initialConfig, true);
  globalThis.fetch = originalFetch; opencodeClient.setDirectory(undefined);
});

export const fixture = {
  get stores() { return stores; },
  get loader() { return loader; },
  set detail(value: (request: Request) => Promise<Response>) { detail = value; },
  set history(value: () => Promise<Response>) { history = value; },
};
