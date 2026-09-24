import { afterEach, expect, test } from 'bun:test';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { managedBootstrapVerdict } from './managed-bootstrap-gate';

afterEach(() => useProjectsStore.getState().resetManagedCatalog());

test('bootstraps wait for discovery, then only catalog rows run on a managed catalog', () => {
  useProjectsStore.getState().resetManagedCatalog();
  expect(managedBootstrapVerdict('/home/user', false)).toBe('wait');
  expect(managedBootstrapVerdict('/home/user', true)).toBe('allow');
  useProjectsStore.getState().admitManagedCatalog();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'r', worktree: '/repo/admitted' }]);
  expect(useDirectoryStore.getState().managedDirectories).toEqual(['/repo/admitted']);
  expect(managedBootstrapVerdict('/repo/admitted/', false)).toBe('allow');
  expect(managedBootstrapVerdict('/home/user', false)).toBe('deny');
});

test('a stock catalog bootstraps everything', () => {
  useProjectsStore.setState({ managedCatalogStatus: 'stock', managedCatalogAdmitted: false });
  expect(managedBootstrapVerdict('/home/user', false)).toBe('allow');
});
