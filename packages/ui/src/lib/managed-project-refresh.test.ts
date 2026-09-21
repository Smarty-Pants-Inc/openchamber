import { beforeEach, expect, mock, test } from 'bun:test';
import type { ManagedProject } from './managed-project-catalog';
import { deferred } from './runtime-isolation-fixture';

let generation = 0;
let changed = () => {};
let admitted = false;
let status = 'unknown';
let publications: ManagedProject[][] = [];
let sessionsPublished = 0;
const response = (marked = true, status = 200) => new Response(null, {
  status, headers: marked ? { 'X-Smarty-Code-Catalog': 'managed-v1' } : {},
});
const row = { id: 'a', worktree: '/allowed/a' };
let projectRead = async () => ({ response: response(), data: [row] });
let sessionRead = async () => [{ directory: '/allowed/a' }];
const projectState = {
  get managedCatalogAdmitted() { return admitted; },
  admitManagedCatalog() { admitted = true; },
  resetManagedCatalog() { admitted = false; status = 'unknown'; publications = []; },
  applyManagedCatalog(rows: ManagedProject[]) { publications.push(rows); status = 'ready'; },
};
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  getSdkClient: () => ({ project: { list: () => projectRead() } }),
} }));
mock.module('@/lib/runtime-switch', () => ({
  captureRuntimeRequestScope: () => generation,
  isRuntimeRequestScopeCurrent: (scope: number) => scope === generation,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { changed = callback; return () => {}; },
}));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: {
  getState: () => projectState,
  setState: (patch: { managedCatalogStatus: string }) => { status = patch.managedCatalogStatus; },
} }));
mock.module('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: {
  getState: () => ({ applyManagedSessions: () => { sessionsPublished++; } }),
} }));
mock.module('@/stores/globalSessions', () => ({ listGlobalSessionPages: () => sessionRead() }));
mock.module('@/stores/utils/vscodeRuntime', () => ({ isVSCodeRuntime: () => false }));
const { refreshManagedProjects } = await import('./managed-project-refresh');

beforeEach(() => {
  generation++; changed(); sessionsPublished = 0;
  projectRead = async () => ({ response: response(), data: [row] });
  sessionRead = async () => [{ directory: '/allowed/a' }];
});

test('success publishes, lost marker preserves membership as unavailable', async () => {
  await refreshManagedProjects();
  expect(publications).toEqual([[row]]); expect(sessionsPublished).toBe(1);
  projectRead = async () => ({ response: response(false), data: [] });
  await refreshManagedProjects();
  expect(status).toBe('unavailable'); expect(publications).toEqual([[row]]);
  expect(sessionsPublished).toBe(1);
});

test('successful empty publishes only after a successful global read', async () => {
  projectRead = async () => ({ response: response(), data: [] });
  sessionRead = async () => [];
  await refreshManagedProjects();
  expect(publications).toEqual([[]]); expect(status).toBe('ready');
});

test('failed global read cannot turn last-known membership into empty', async () => {
  await refreshManagedProjects();
  projectRead = async () => ({ response: response(), data: [] });
  sessionRead = async () => { throw new Error('unavailable'); };
  await refreshManagedProjects();
  expect(publications).toEqual([[row]]); expect(status).toBe('unavailable');
});

test('endpoint switch resets admission and drops late project response', async () => {
  const held = deferred<{ response: Response; data: typeof row[] }>();
  projectRead = () => held.promise;
  const pending = refreshManagedProjects();
  generation++; changed();
  held.resolve({ response: response(), data: [row] }); await pending;
  expect(admitted).toBe(false); expect(publications).toEqual([]); expect(sessionsPublished).toBe(0);
});

test('late session response cannot publish after endpoint switch', async () => {
  const held = deferred<{ directory: string }[]>();
  const entered = deferred<void>();
  sessionRead = () => { entered.resolve(); return held.promise; };
  const pending = refreshManagedProjects(); await entered.promise;
  generation++; changed(); held.resolve([{ directory: '/allowed/a' }]); await pending;
  expect(admitted).toBe(false); expect(publications).toEqual([]); expect(sessionsPublished).toBe(0);
});

test('fresh reconnect supersedes a held older sample without a second poller', async () => {
  const held = deferred<{ response: Response; data: typeof row[] }>();
  projectRead = () => held.promise;
  const older = refreshManagedProjects();
  projectRead = async () => ({ response: response(), data: [] }); sessionRead = async () => [];
  await refreshManagedProjects(true);
  held.resolve({ response: response(), data: [row] }); await older;
  expect(publications).toEqual([[]]); expect(sessionsPublished).toBe(1);
});
