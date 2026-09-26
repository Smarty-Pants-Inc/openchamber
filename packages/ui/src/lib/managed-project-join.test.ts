import { beforeEach, expect, mock, test } from 'bun:test';

// Run in its own process (CI's isolated runner): the module mock is this file's.
// smarty-dev#777: a project added to a managed catalog joins the open event stream (the gateway keeps it open), and
// its server.connected refreshes the catalog once; a known project, or a catalog not loaded yet, refreshes nothing.
let refreshes: boolean[] = [];
mock.module('@/lib/managed-project-refresh', () => ({ refreshManagedProjects: async (fresh?: boolean) => { refreshes.push(fresh === true); } }));
const { JOIN_DEBOUNCE_MS, noticeProjectConnected } = await import('./managed-project-join');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const settle = () => new Promise(resolve => setTimeout(resolve, JOIN_DEBOUNCE_MS + 50));

beforeEach(() => {
  refreshes = [];
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
    managedProjects: [{ id: 'a', path: '/fleet/a', label: 'a' }] } as never);
});

test('a new project connecting on the open stream refreshes the managed catalog once per burst', async () => {
  noticeProjectConnected('/fleet/b'); noticeProjectConnected('/fleet/b'); noticeProjectConnected('/fleet/c');
  await settle();
  expect(refreshes).toEqual([true]);
});

test('a listed project, the global stream, or a catalog that has not loaded yet refreshes nothing', async () => {
  noticeProjectConnected('/fleet/a'); noticeProjectConnected('global'); noticeProjectConnected(undefined);
  useProjectsStore.setState({ managedCatalogStatus: 'unknown' } as never);
  noticeProjectConnected('/fleet/b');
  useProjectsStore.setState({ managedCatalogStatus: 'ready', managedCatalogAdmitted: false } as never);
  noticeProjectConnected('/fleet/b');
  await settle();
  expect(refreshes).toEqual([]);
});
