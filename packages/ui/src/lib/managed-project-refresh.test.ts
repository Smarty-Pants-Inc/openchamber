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
  get managedCatalogStatus() { return status; },
  admitManagedCatalog() { admitted = true; },
  resetManagedCatalog() { admitted = false; status = 'unknown'; publications = []; },
  applyManagedCatalog(rows: ManagedProject[]) { publications.push(rows); status = 'ready'; },
};
let statusRead = async (): Promise<{ data: Record<string, { type: string }> } | null> => ({ data: {} });
const seeded: unknown[][] = [];
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  getSdkClient: () => ({ project: { list: () => projectRead() }, session: { status: () => statusRead() } }),
} }));
mock.module('@/sync/global-session-status', () => ({ getSessionStatusEventVersion: () => 0,
  applyFleetSessionStatuses: (...args: unknown[]) => { seeded.push(args.slice(0, 2)); } }));
mock.module('@/lib/runtime-switch', () => ({
  captureRuntimeRequestScope: () => generation,
  isRuntimeRequestScopeCurrent: (scope: number) => scope === generation,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { changed = callback; return () => {}; },
}));
mock.module('@/stores/useProjectsStore', () => ({
  canAddProjects: (state: typeof projectState) => !state.managedCatalogAdmitted && state.managedCatalogStatus === 'stock',
  useProjectsStore: {
  getState: () => projectState,
  setState: (patch: { managedCatalogStatus: string }) => { status = patch.managedCatalogStatus; },
} }));
mock.module('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: {
  getState: () => ({ applyManagedSessions: () => { sessionsPublished++; } }),
} }));
let sessionReadOptions: unknown;
mock.module('@/stores/globalSessions', () => ({ listGlobalSessionPages: (_sdk: unknown, options: unknown) => { sessionReadOptions = options; return sessionRead(); } }));
mock.module('@/stores/utils/vscodeRuntime', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/chatDirectories', () => ({ warmChatsRootDirectory: async () => {} }));
const { refreshManagedProjects } = await import('./managed-project-refresh');
const { resolveProjectAddAllowed } = await import('./managed-project-add');

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

test('the membership read does not wait behind background polls', async () => {
  await refreshManagedProjects(true);
  expect(sessionReadOptions).toMatchObject({ archived: true, ungated: true });
});

test('publishing seeds every session directory from the fleet-wide status map', async () => {
  sessionRead = async () => [{ id: 's1', directory: '/allowed/a' }, { id: 's2', directory: '/allowed/a' }] as never;
  statusRead = async () => ({ data: { s1: { type: 'busy' }, other: { type: 'busy' } } });
  seeded.length = 0;
  await refreshManagedProjects(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(seeded).toEqual([[[{ id: 's1', directory: '/allowed/a' }, { id: 's2', directory: '/allowed/a' }], { s1: { type: 'busy' }, other: { type: 'busy' } }]]);
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

for (const success of [true, false]) test(`superseded callers await current discovery, success=${success}`, async () => {
  // A failed current read is retried twice (#126 item 12); those retries fail the same way.
  const reads = Array.from({ length: 5 }, () => deferred<{ response: Response; data: typeof row[] }>());
  for (const retry of reads.slice(3)) retry.resolve({ response: response(false, 403), data: [] });
  let calls = 0, settled = false;
  projectRead = () => reads[calls++]!.promise;
  const older = refreshManagedProjects().then(() => { settled = true; });
  const middle = refreshManagedProjects(true), latest = refreshManagedProjects(true);
  const joined = refreshManagedProjects();
  reads[0]!.resolve({ response: response(false), data: [] });
  reads[1]!.resolve({ response: response(false), data: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false); expect(status).toBe('unknown');
  reads[2]!.resolve({ response: response(false, success ? 200 : 403), data: [] });
  await Promise.all([older, middle, latest, joined]);
  expect(calls).toBe(success ? 3 : 5); expect(status).toBe(success ? 'stock' : 'unavailable');
  expect(admitted).toBe(false); expect(publications).toEqual([]); expect(sessionsPublished).toBe(0);
});

test('stale runtime/auth scope does not follow a held successor or publish', async () => {
  const first = deferred<{ response: Response; data: typeof row[] }>();
  const second = deferred<{ response: Response; data: typeof row[] }>();
  projectRead = () => first.promise;
  const older = refreshManagedProjects();
  generation++; changed();
  projectRead = () => second.promise;
  const current = refreshManagedProjects();
  first.resolve({ response: response(), data: [row] }); await older;
  expect(status).toBe('unknown'); expect(admitted).toBe(false); expect(publications).toEqual([]);
  second.resolve({ response: response(false), data: [] }); await current;
  expect(status).toBe('stock'); expect(publications).toEqual([]);
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

// An explicit Add while discovery is unresolved retries it and adds only on an affirmative stock answer.
test('add request retries unresolved discovery and allows only stock', async () => {
  projectRead = async () => { throw new Error('offline'); };
  await refreshManagedProjects();
  expect(status).toBe('unavailable');
  expect(await resolveProjectAddAllowed()).toBe(false);
  projectRead = async () => ({ response: response(false), data: [] });
  expect(await resolveProjectAddAllowed()).toBe(true);
  expect(status).toBe('stock');
});

test('add request refuses when the retry finds a managed catalog', async () => {
  projectRead = async () => { throw new Error('offline'); };
  await refreshManagedProjects();
  projectRead = async () => ({ response: response(), data: [row] });
  expect(await resolveProjectAddAllowed()).toBe(false);
  expect(admitted).toBe(true);
});

// #126 item 12: a project admitted between the /project read and the session read is not an outage.
test('a catalog change during the session read retries and publishes the new catalog', async () => {
  const added = { id: 'b', worktree: '/allowed/b' };
  let projectReads = 0;
  projectRead = async () => ({ response: response(), data: projectReads++ === 0 ? [row] : [row, added] });
  sessionRead = async () => [{ directory: '/allowed/a' }, { directory: '/allowed/b' }];
  await refreshManagedProjects();
  expect(projectReads).toBe(2); expect(status).toBe('ready');
  expect(publications).toEqual([[row, added]]); expect(sessionsPublished).toBe(1);
});

test('retries are bounded and a final failure keeps the rows already applied', async () => {
  await refreshManagedProjects();
  let projectReads = 0;
  projectRead = async () => { projectReads++; return { response: response(), data: [row] }; };
  sessionRead = async () => [{ directory: '/not/admitted' }];
  await refreshManagedProjects();
  expect(projectReads).toBe(3); expect(status).toBe('unavailable');
  expect(publications).toEqual([[row]]); expect(sessionsPublished).toBe(1);
});
