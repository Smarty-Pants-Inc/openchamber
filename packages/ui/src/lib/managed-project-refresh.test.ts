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
const { refreshManagedProjects, DISCOVERY_TIMEOUT_MS, UNAVAILABLE_RETRY_DELAYS_MS, setCatalogReadLimitsForTest } = await import('./managed-project-refresh');
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

// smarty-code MVP 1 G13: a fresh profile's first discovery on a loaded host stayed "unavailable" until a user action.
test('the first discovery waits as long as later refreshes (30 s), and retries back off 2/5/10/20/30 s', () => {
  expect(DISCOVERY_TIMEOUT_MS).toBe(30_000);
  expect(UNAVAILABLE_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 10_000, 20_000, 30_000]);
});

test('an unavailable catalog retries on its own and publishes once the server answers; an endpoint change stops it', async () => {
  const saved = UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, 10, 20, 40);
  try {
    let reads = 0, failing = true;
    projectRead = async () => { reads++; return failing ? { response: response(true, 503), data: [] } : { response: response(), data: [row] }; };
    await refreshManagedProjects(true);
    expect(status).toBe('unavailable'); expect(publications).toEqual([]);
    const afterFirst = reads;
    await new Promise(resolve => setTimeout(resolve, 700)); // Retries at 10, then 20 ms after each failed round.
    expect(reads).toBeGreaterThan(afterFirst); expect(status).toBe('unavailable');
    failing = false;
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(status).toBe('ready'); expect(publications).toEqual([[row]]);
    const settled = reads;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(reads).toBe(settled); // Answered: no more retries.

    failing = true; generation++; changed(); // Endpoint switch while unavailable: its retry must stop.
    await refreshManagedProjects(true);
    expect(status).toBe('unavailable');
    generation++; changed();
    const stopped = reads;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(reads).toBe(stopped);
  } finally { UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, ...saved); }
});

test('a retry timer from an older auth scope does not block the current scope\'s retry (no endpoint event)', async () => {
  const saved = UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, 200, 200);
  try {
    let failing = true;
    projectRead = async () => failing ? { response: response(true, 503), data: [] } : { response: response(), data: [row] };
    await refreshManagedProjects(true); // Old scope fails: a retry is scheduled for it.
    generation++; // Renewed auth: a new scope, with no endpoint-change event.
    await refreshManagedProjects(true); // New scope fails too: its own retry must replace the old timer.
    failing = false;
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(status).toBe('ready');
  } finally { UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, ...saved); }
});

// smarty-code#113: a fresh profile's first discovery read can take longer than the page's wait (30 s; 30 ms here, and a
// "40 s" read is 40 ms). Slow is not failed: the page keeps 'Loading projects…' and the answer publishes.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const slowRead = (ms: number, answer: () => { response: Response; data: typeof row[] }) => async () => { await sleep(ms); return answer(); };

test('a first read that takes longer than the wait, then succeeds, never shows unavailable', async () => {
  setCatalogReadLimitsForTest(30, 30);
  try {
    const seen: string[] = [];
    projectRead = slowRead(40, () => ({ response: response(), data: [row] }));
    const request = refreshManagedProjects(true);
    const watch = setInterval(() => seen.push(status), 2);
    await request; // Callers stop waiting at the limit; the read keeps running.
    expect(status).toBe('unknown');
    // An ordinary refresh meanwhile waits for the running read instead of starting over.
    let reads = 0; const inner = projectRead; projectRead = async () => { reads++; return inner(); };
    await refreshManagedProjects();
    await sleep(60);
    clearInterval(watch);
    expect(seen).not.toContain('unavailable');
    expect(status).toBe('ready'); expect(publications).toEqual([[row]]);
    expect(reads).toBe(0);
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); }
});

test('a slow first read that ends in an error answer (503) still shows unavailable', async () => {
  setCatalogReadLimitsForTest(30, 30);
  const saved = UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, 10_000);
  try {
    projectRead = slowRead(40, () => ({ response: response(true, 503), data: [] }));
    await refreshManagedProjects(true);
    expect(status).toBe('unknown');
    // Its bounded retries run in the background (150 and 300 ms apart), then the error answer decides.
    for (let waited = 0; status === 'unknown' && waited < 2000; waited += 20) await sleep(20);
    expect(status).toBe('unavailable'); expect(publications).toEqual([]);
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, ...saved); }
});

test('a slow retry after an unavailable catalog is not superseded: its answer replaces the banner', async () => {
  setCatalogReadLimitsForTest(2000, 30); // The first request's three failing attempts settle as unavailable.
  const saved = UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, 5, 5);
  try {
    let reads = 0;
    // The first request's three attempts fail (503); the next read, by the retry, is slow and then answers.
    projectRead = async () => { reads++; return reads <= 3 ? { response: response(true, 503), data: [] } : (await sleep(60), { response: response(), data: [row] }); };
    await refreshManagedProjects(true);
    expect(status).toBe('unavailable');
    await sleep(150);
    expect(status).toBe('ready'); expect(publications).toEqual([[row]]);
    expect(reads).toBe(4); // The retries waited for the slow read instead of starting new ones.
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, ...saved); }
});

test('a fresh refresh supersedes a slow read: later refreshes and retries are not held by it', async () => {
  setCatalogReadLimitsForTest(30, 30);
  try {
    let reads = 0;
    projectRead = async () => { reads++; if (reads === 1) await sleep(300); return { response: response(), data: [row] }; };
    await refreshManagedProjects(true); // Slow: still running.
    await refreshManagedProjects(true); // A reconnect: a new read, which answers.
    expect(status).toBe('ready');
    const before = reads;
    await refreshManagedProjects(); // An ordinary refresh is not held by the superseded slow read.
    expect(reads).toBe(before + 1);
    await sleep(300);
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); }
});

test('a slow read whose catalog changed mid-read retries in the background and publishes, not unavailable', async () => {
  setCatalogReadLimitsForTest(30, 30);
  try {
    let sessionReads = 0;
    sessionRead = async () => { sessionReads++; await sleep(40); return sessionReads === 1 ? [{ directory: '/not/yet/published' }] : [{ directory: '/allowed/a' }]; };
    const seen: string[] = [];
    const watch = setInterval(() => seen.push(status), 2);
    await refreshManagedProjects(true);
    for (let waited = 0; status !== 'ready' && waited < 1000; waited += 20) await sleep(20);
    clearInterval(watch);
    expect(status).toBe('ready'); expect(seen).not.toContain('unavailable');
    expect(sessionReads).toBe(2);
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); }
});

test('a read that never answers (the SDK bound) keeps Loading and tries again; its later answer publishes', async () => {
  setCatalogReadLimitsForTest(30, 30);
  const saved = UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, 10);
  try {
    let reads = 0;
    const seen: string[] = [];
    projectRead = async () => { reads++; if (reads <= 3) throw new Error('OpenCode request timed out after 120000ms'); return { response: response(), data: [row] }; };
    const watch = setInterval(() => seen.push(status), 2);
    await refreshManagedProjects(true);
    for (let waited = 0; status !== 'ready' && waited < 2000; waited += 20) await sleep(20);
    clearInterval(watch);
    expect(status).toBe('ready'); expect(seen).not.toContain('unavailable'); expect(reads).toBe(4);
  } finally { setCatalogReadLimitsForTest(30_000, 30_000); UNAVAILABLE_RETRY_DELAYS_MS.splice(0, UNAVAILABLE_RETRY_DELAYS_MS.length, ...saved); }
});
