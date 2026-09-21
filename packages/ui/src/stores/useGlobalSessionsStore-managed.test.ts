import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { deferred } from '@/lib/runtime-isolation-fixture';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from './useProjectsStore';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSessionLifecycleOrderValue, resetSessionOrdering } from '@/sync/session-ordering';

const a = '/managed/a', b = '/managed/b';
const project = { id: 'a', worktree: a };
const session = (id: string, directory = a, updated = 1): Session => ({
  id, slug: id, projectID: 'a', directory, title: id, version: 'test', time: { created: 1, updated },
});
let globalRead = deferred<Session[]>();
let entered = deferred<void>();
let restoreReads = () => {};

beforeEach(() => {
  globalRead = deferred<Session[]>(); entered = deferred<void>();
  resetSessionOrdering();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useProjectsStore.getState().resetManagedCatalog();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  const sdk = opencodeClient.getSdkClient();
  const projects = spyOn(sdk.project, 'list').mockImplementation(async options => {
    expect(options).toBeUndefined();
    return { data: [{ ...project, time: { created: 1, updated: 1 }, sandboxes: [] }],
      request: new Request('http://catalog.test/project'),
      response: new Response(null, { headers: { 'X-Smarty-Code-Catalog': 'managed-v1' } }) };
  });
  const sessions = spyOn(sdk.experimental.session, 'list').mockImplementation(async options => {
    expect(options?.directory).toBeUndefined();
    entered.resolve();
    return { data: (await globalRead.promise).map(row => ({ ...row, project: null })),
      request: new Request('http://catalog.test/experimental/session'), response: new Response() };
  });
  restoreReads = () => { projects.mockRestore(); sessions.mockRestore(); };
});
afterEach(() => { restoreReads(); useProjectsStore.getState().resetManagedCatalog(); });

test('actual managed global read overlays newer events, filters retired directories and preserves new selection', async () => {
  const updated = session('updated'), deleted = session('deleted'), removed = session('removed-project', b);
  useProjectsStore.getState().applyManagedCatalog([project]);
  useGlobalSessionsStore.getState().applySnapshot([updated, deleted, removed], []);
  const refreshing = refreshManagedProjects(true); await entered.promise;
  useGlobalSessionsStore.getState().upsertSession({ ...updated, title: 'New event title', time: { created: 1, updated: 90 } });
  useGlobalSessionsStore.getState().removeSessions([deleted.id]);
  useGlobalSessionsStore.getState().upsertSession(session('created', a, 100));
  useGlobalSessionsStore.getState().upsertSession(session('removed-project', b, 110));
  useSessionUIStore.setState({ currentSessionId: 'created', currentSessionDirectory: a });
  globalRead.resolve([updated, deleted]); await refreshing;
  const state = useGlobalSessionsStore.getState();
  expect(state.activeSessions.map(row => row.id).sort()).toEqual(['created', 'updated']);
  expect(state.entityById.get('updated')?.title).toBe('New event title');
  expect(state.sessionsByDirectory.has(b)).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('created');
});

test('managed publication raises existing ordering baselines using the committed snapshot', async () => {
  const old = session('order', a, 1);
  expect(getSessionLifecycleOrderValue(old, new Map())).toBe(1);
  const refreshing = refreshManagedProjects(true); await entered.promise;
  globalRead.resolve([session('order', a, 200)]); await refreshing;
  expect(getSessionLifecycleOrderValue(old, new Map())).toBe(200);
});
