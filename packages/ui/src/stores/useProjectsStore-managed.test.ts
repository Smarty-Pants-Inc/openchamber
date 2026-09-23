import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as settings from '@/lib/persistence';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from './useProjectsStore';
import { useDirectoryStore } from './useDirectoryStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const storage = getDeferredSafeStorage();

// #126 item 8: the live managed catalog is the only project source.
const live = { id: 'live', worktree: '/live/project', name: 'live' };
const saved: ProjectEntry = { id: 'stale', path: '/sandbox/home/stale', label: 'Stale bookmark', addedAt: 1, lastOpenedAt: 1 };
let restore: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  storage.removeItem('lastDirectory');
  useProjectsStore.setState({ projects: [saved], activeProjectId: null, managedCatalogAdmitted: false,
    managedCatalogStatus: 'unknown', managedRows: null, managedProjects: null });
});
afterEach(() => { for (const spy of restore.splice(0)) spy.mockRestore(); useProjectsStore.getState().resetManagedCatalog(); });
const spies = () => {
  const save = spyOn(settings, 'updateDesktopSettings').mockResolvedValue(undefined);
  const mkdir = spyOn(opencodeClient, 'createDirectory');
  const note = spyOn(toast, 'info');
  restore = [save, mkdir, note];
  return { save, mkdir, note };
};

test('managed add is refused with no settings write and no folder creation', async () => {
  const { save, mkdir } = spies();
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(await useProjectsStore.getState().addProject('/home/paul/Projects/typed')).toBeNull();
  expect(await useProjectsStore.getState().addProjects(['/a', '/b'])).toEqual([]);
  expect(useProjectsStore.getState().projects).toEqual([saved]);
  expect(useProjectsStore.getState().managedProjects?.map(project => project.path)).toEqual([live.worktree]);
  expect(save).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
});

test('a stale active project falls back to the first admitted project with one visible note', () => {
  const { save, note } = spies();
  useProjectsStore.setState({ activeProjectId: saved.id });
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(useProjectsStore.getState().activeProjectId).toBe(createdId());
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  expect(note).toHaveBeenCalledTimes(1);
  expect(String(note.mock.calls[0]![0])).toBe('Saved project Stale bookmark is not in the live catalog. Showing live.');
  useProjectsStore.setState({ activeProjectId: saved.id });
  useProjectsStore.getState().applyManagedCatalog([live]); // Shown once.
  expect(note).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

test('a stale lastDirectory falls back with a note; an admitted one is silent', () => {
  const { note } = spies();
  storage.setItem('lastDirectory', '/sandbox/home/home/paul/Projects/smarty-code');
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  expect(String(note.mock.calls[0]![0])).toContain('/sandbox/home/home/paul/Projects/smarty-code');
  storage.setItem('lastDirectory', `${live.worktree}/`);
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(note).toHaveBeenCalledTimes(1);
});

test('stock add is unchanged', async () => {
  const { save } = spies();
  const added = await useProjectsStore.getState().addProject('/stock/project');
  expect(added?.path).toBe('/stock/project');
  expect(useProjectsStore.getState().projects.map(project => project.path)).toEqual([saved.path, '/stock/project']);
  expect(save.mock.calls.length).toBeGreaterThan(0);
});

function createdId() { return useProjectsStore.getState().managedProjects![0]!.id; }
