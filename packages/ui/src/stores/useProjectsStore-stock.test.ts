import { afterEach, expect, test } from 'bun:test';
import { useProjectsStore } from './useProjectsStore';
import { showsActivitySections } from '@/components/session/sidebar/list/chatGroupVisibility';

// smarty-code#126 (c), OC#169 review: the sidebar reads the runtime's stock answer from the store, so closing and
// reopening it (unmount/remount), or discovery answering while it is closed, never loses or invents that answer.
afterEach(() => useProjectsStore.getState().resetManagedCatalog());
const set = (managedCatalogAdmitted: boolean, managedCatalogStatus: 'unknown' | 'stock' | 'ready' | 'unavailable') =>
  useProjectsStore.setState({ managedCatalogAdmitted, managedCatalogStatus });
/** What a freshly mounted sidebar shows: it has no state of its own, only the store's. */
const mountedSidebarShows = () => showsActivitySections({ isVSCode: false,
  stockConfirmed: useProjectsStore.getState().managedCatalogStockConfirmed });

test('stock: confirmed, then the sidebar is closed while a refresh fails, then reopened: the sections still show', () => {
  useProjectsStore.getState().resetManagedCatalog();
  expect(mountedSidebarShows()).toBe(false); // Before discovery answers.
  set(false, 'stock');
  expect(mountedSidebarShows()).toBe(true);
  set(false, 'unavailable'); // While the sidebar is closed: no component is mounted.
  expect(mountedSidebarShows()).toBe(true); // Reopened.
  useProjectsStore.getState().resetManagedCatalog(); // A runtime switch forgets it.
  expect(mountedSidebarShows()).toBe(false);
});

test('managed: the first discovery fails, then managed answers; the sections never show, open or closed', () => {
  useProjectsStore.getState().resetManagedCatalog();
  const seen: boolean[] = [];
  for (const [admitted, status] of [[false, 'unavailable'], [true, 'unknown'], [true, 'ready'], [true, 'unavailable']] as const) {
    set(admitted, status); seen.push(mountedSidebarShows());
  }
  expect(seen).toEqual([false, false, false, false]);
});
