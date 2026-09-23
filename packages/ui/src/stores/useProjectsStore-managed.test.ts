import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import * as settings from '@/lib/persistence';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { useProjectsStore } from './useProjectsStore';
import { useDirectoryStore } from './useDirectoryStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const storage = getDeferredSafeStorage();

// #126 item 8: the live managed catalog is the only project source.
const live = { id: 'live', worktree: '/live/project', name: 'live' };
const other = { id: 'other', worktree: '/live/other', name: 'other' };
// Notes are deduplicated per page load by saved identity, so each test saves a fresh identity.
let run = 0;
let saved: ProjectEntry;
let restore: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  const path = `/sandbox/home/stale-${++run}`;
  saved = { id: createProjectIdFromPath(path), path, label: 'Stale bookmark', addedAt: 1, lastOpenedAt: 1 };
  storage.removeItem('lastDirectory');
  storage.removeItem('activeProjectId'); // The saved pointer cache (no runtime namespace in tests).
  useProjectsStore.setState({ projects: [saved], activeProjectId: null, managedCatalogAdmitted: false,
    managedCatalogStatus: 'stock', managedRows: null, managedProjects: null });
});
afterEach(() => { for (const spy of restore.splice(0)) spy.mockRestore(); useProjectsStore.getState().resetManagedCatalog(); });
const spies = () => {
  const save = spyOn(settings, 'updateDesktopSettings').mockResolvedValue(undefined);
  const mkdir = spyOn(opencodeClient, 'createDirectory');
  const note = spyOn(toast, 'info');
  restore = [save, mkdir, note];
  return { save, mkdir, note };
};
/** Record a saved active pointer through the stock owner, then forget that write. */
const saveActive = (id: string, save: ReturnType<typeof spies>['save']) => {
  useProjectsStore.getState().setActiveProjectIdOnly(id);
  save.mockClear();
};
const noteText = (note: ReturnType<typeof spies>['note']) => note.mock.calls.map(call => String(call[0]));

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

// Before discovery answers, the runtime may still be managed; only an affirmative stock answer permits add.
for (const status of ['unknown', 'unavailable'] as const) test(`add is refused while the catalog is ${status}`, async () => {
  const { save } = spies();
  useProjectsStore.setState({ managedCatalogStatus: status });
  expect(await useProjectsStore.getState().addProject('/typed/while/loading')).toBeNull();
  expect(await useProjectsStore.getState().addProjects(['/a'])).toEqual([]);
  expect(useProjectsStore.getState().projects).toEqual([saved]);
  expect(save).not.toHaveBeenCalled();
});

test('a stale active project falls back to the first admitted project with one visible note', async () => {
  const { save, note } = spies();
  saveActive(saved.id, save);
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(useProjectsStore.getState().activeProjectId).toBe(createdId());
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  await sleep(0);
  expect(noteText(note)).toEqual(['Saved project Stale bookmark is not in the live catalog. Showing live.']);
  useProjectsStore.getState().applyManagedCatalog([live]); // Shown once.
  await sleep(0);
  expect(note).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

test('one note per saved identity, even when a stale lastDirectory would name it differently', async () => {
  const { save, note } = spies();
  saveActive(saved.id, save);
  storage.setItem('lastDirectory', '/old');
  useProjectsStore.getState().applyManagedCatalog([live]);
  useProjectsStore.getState().applyManagedCatalog([live]); // A refresh sees the presentation pointer, not the saved one.
  await sleep(0);
  useProjectsStore.getState().applyManagedCatalog([live]);
  await sleep(0);
  expect(noteText(note)).toEqual(['Saved project Stale bookmark is not in the live catalog. Showing live.']);
});

test('the note names the project shown after final selection', async () => {
  const { save, note } = spies();
  saveActive(saved.id, save);
  useProjectsStore.getState().applyManagedCatalog([live, other]);
  // Session restoration selects another admitted project in the same turn.
  useProjectsStore.getState().setActiveProject(useProjectsStore.getState().managedProjects![1]!.id);
  await sleep(0);
  expect(noteText(note)).toEqual(['Saved project Stale bookmark is not in the live catalog. Showing other.']);
});

test('settings that arrive after admission are reconciled and noted', async () => {
  const { note } = spies();
  useProjectsStore.getState().applyManagedCatalog([live]);
  await sleep(0);
  expect(note).not.toHaveBeenCalled();
  useProjectsStore.getState().synchronizeFromSettings({ projects: [saved], activeProjectId: saved.id, lastDirectory: live.worktree });
  await sleep(0);
  expect(useProjectsStore.getState().activeProjectId).toBe(createdId());
  expect(noteText(note)).toEqual(['Saved project Stale bookmark is not in the live catalog. Showing live.']);
});

test('a stale lastDirectory falls back with a note; an admitted one is silent', async () => {
  const { note } = spies();
  storage.setItem('lastDirectory', '/sandbox/home/home/paul/Projects/smarty-code');
  useProjectsStore.getState().applyManagedCatalog([live]);
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  await sleep(0);
  expect(noteText(note)[0]).toContain('/sandbox/home/home/paul/Projects/smarty-code');
  storage.setItem('lastDirectory', `${live.worktree}/`);
  useProjectsStore.getState().applyManagedCatalog([live]);
  await sleep(0);
  expect(note).toHaveBeenCalledTimes(1);
});

test('delayed startup restoration after admission keeps the live fallback and writes nothing', async () => {
  const { save } = spies();
  useProjectsStore.getState().applyManagedCatalog([live]);
  const priorWindow = globalThis.window;
  Object.assign(globalThis, { window: { localStorage: { getItem: () => '/sandbox/home/stale' } } });
  try { await applyPersistedDirectoryPreferences(); } finally { Object.assign(globalThis, { window: priorWindow }); }
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  expect(save).not.toHaveBeenCalled();
  // Home restoration cannot replace an empty admitted catalog's selection either.
  useProjectsStore.getState().applyManagedCatalog([]);
  useDirectoryStore.getState().synchronizeHomeDirectory('/sandbox/home');
  expect(useDirectoryStore.getState().currentDirectory).toBe('');
  expect(save.mock.calls.some(([changes]) => 'lastDirectory' in changes)).toBe(false);
});

test('managed bookmark edits never persist the presentation-only active project', () => {
  const { save } = spies();
  saveActive(saved.id, save);
  useProjectsStore.getState().applyManagedCatalog([live]);
  useProjectsStore.getState().renameProject(saved.id, 'Renamed');
  useProjectsStore.getState().updateProjectMeta(saved.id, { color: 'red' });
  useProjectsStore.getState().reorderProjects(0, 0);
  useProjectsStore.getState().removeProject(saved.id);
  expect(save).toHaveBeenCalledTimes(3);
  for (const [changes] of save.mock.calls) expect('activeProjectId' in changes).toBe(false);
});

test('stock add is unchanged', async () => {
  const { save } = spies();
  const added = await useProjectsStore.getState().addProject('/stock/project');
  expect(added?.path).toBe('/stock/project');
  expect(useProjectsStore.getState().projects.map(project => project.path)).toEqual([saved.path, '/stock/project']);
  expect(save.mock.calls.length).toBeGreaterThan(0);
});

function createdId() { return useProjectsStore.getState().managedProjects![0]!.id; }
