import { beforeEach, expect, mock, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';

// Run in its own process (CI's isolated runner): the module mock is this file's.
// smarty-dev#777: a project added to a managed catalog joins the open event stream (the gateway keeps it open), and
// its server.connected refreshes the catalog once; a listed project, or a catalog that is not managed, refreshes
// nothing. A join during discovery is kept until the catalog loads (#282 review).
let refreshes: boolean[] = [];
mock.module('@/lib/managed-project-refresh', () => ({ refreshManagedProjects: async (fresh?: boolean) => { refreshes.push(fresh === true); } }));
const { JOIN_DEBOUNCE_MS, noticeProjectConnected } = await import('./managed-project-join');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const settle = () => new Promise(resolve => setTimeout(resolve, JOIN_DEBOUNCE_MS + 50));
const listed = (...paths: string[]): ProjectEntry[] => paths.map(path => ({ id: path, path, label: path }));

beforeEach(() => {
  refreshes = [];
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedProjects: listed('/fleet/a') });
});

test('a new project connecting on the open stream refreshes the managed catalog once per burst', async () => {
  noticeProjectConnected('/fleet/b'); noticeProjectConnected('/fleet/b'); noticeProjectConnected('/fleet/c');
  await settle();
  expect(refreshes).toEqual([true]);
});

test('a listed project, the global stream, or a catalog that is not managed refreshes nothing', async () => {
  noticeProjectConnected('/fleet/a'); noticeProjectConnected('global'); noticeProjectConnected(undefined);
  useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
  noticeProjectConnected('/fleet/b');
  await settle();
  expect(refreshes).toEqual([]);
});

test('a join during the first discovery is kept: the catalog that loads without it is refreshed once', async () => {
  // The first discovery has read the project rows (only A) and is still reading sessions: not loaded yet.
  useProjectsStore.setState({ managedCatalogStatus: 'unknown', managedProjects: listed('/fleet/a') });
  noticeProjectConnected('/fleet/b'); // B joins the open stream in that window.
  noticeProjectConnected('/fleet/a'); // A's own startup event: listed, never a reason to refresh.
  await settle();
  expect(refreshes).toEqual([]); // Nothing while discovery runs.
  useProjectsStore.setState({ managedCatalogStatus: 'ready' }); // The old sample publishes, without B.
  await settle();
  expect(refreshes).toEqual([true]); // B is not listed: one refresh brings it in, with no reconnect.
});

test('a join during discovery that the loaded catalog already lists refreshes nothing', async () => {
  useProjectsStore.setState({ managedCatalogStatus: 'unknown', managedProjects: listed('/fleet/a') });
  noticeProjectConnected('/fleet/b');
  useProjectsStore.setState({ managedCatalogStatus: 'ready', managedProjects: listed('/fleet/a', '/fleet/b') });
  await settle();
  expect(refreshes).toEqual([]);
});
