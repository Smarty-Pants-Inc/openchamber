import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as settings from '@/lib/persistence';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { withoutSharingModelPrefs } from '@/lib/modelPrefsRestore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';

// smarty-code#126 F6 / #117: shared settings change only on an explicit user choice.
const PREFS_FLUSH_MS = 1300; // modelPrefsAutoSave debounces 1200 ms.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let save: ReturnType<typeof spyOn<typeof settings, 'updateDesktopSettings'>>;
let stopAutoSave: (() => void) | null = null;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  save = spyOn(settings, 'updateDesktopSettings').mockResolvedValue(undefined);
});
afterEach(() => {
  stopAutoSave?.();
  stopAutoSave = null;
  save.mockRestore();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** modelPrefsAutoSave runs only in a browser; the timers it needs are the global ones. */
const startBrowserAutoSave = () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  stopAutoSave = startModelPrefsAutoSave();
};

test('opening a session writes no shared settings', () => {
  // SAFETY: this test needs only the child-store manager; the fire-and-forget message fetch may fail harmlessly.
  setSyncRefs({} as never, new ChildStoreManager(), '/repo');
  useDirectoryStore.getState().setDirectory('/repo', { showOverlay: false, remember: false });
  const before = save.mock.calls.length;

  useSessionUIStore.getState().setCurrentSession('ses_open_f6', '/repo/.worktrees/feature');

  expect(useDirectoryStore.getState().currentDirectory).toBe('/repo/.worktrees/feature');
  expect(save.mock.calls).toHaveLength(before);
  useSessionUIStore.getState().setCurrentSession(null);
});

test('sending a message (the echo restores its model/effort/agent) writes no shared settings', async () => {
  startBrowserAutoSave();
  // The send echo restores the session's choice through the same store actions a pick uses.
  withoutSharingModelPrefs(() => {
    useUIStore.getState().addRecentModel('anthropic', 'send-echo');
    useUIStore.getState().addRecentEffort('anthropic', 'send-echo', 'high');
    useUIStore.getState().addRecentAgent('build-f6');
  });
  await wait(PREFS_FLUSH_MS);
  expect(save).not.toHaveBeenCalled();
});

test('an explicit model pick still writes the shared model preferences', async () => {
  startBrowserAutoSave();
  useUIStore.getState().addRecentModel('anthropic', 'picked-f6');
  await wait(PREFS_FLUSH_MS);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]?.[0].recentModels?.[0]).toEqual({ providerID: 'anthropic', modelID: 'picked-f6' });
});

test('a restore within the debounce after an explicit pick is not published with it', async () => {
  startBrowserAutoSave();
  useUIStore.getState().addRecentModel('anthropic', 'picked-first');
  // Another session opens within the 1200 ms debounce and restores its own model and effort.
  withoutSharingModelPrefs(() => {
    useUIStore.getState().addRecentModel('openai', 'restored-other');
    useUIStore.getState().addRecentEffort('openai', 'restored-other', 'low');
  });
  await wait(PREFS_FLUSH_MS);
  expect(save).toHaveBeenCalledTimes(1);
  const sent = save.mock.calls[0]?.[0];
  expect(sent?.recentModels?.[0]).toEqual({ providerID: 'anthropic', modelID: 'picked-first' });
  expect(JSON.stringify(sent).includes('restored-other')).toBe(false);
});

test('a later explicit pick writes only its own fields, merged onto the shared copy, with no restored recents', async () => {
  useUIStore.setState({ recentModels: [{ providerID: 'anthropic', modelID: 'shared-a' }], recentEfforts: {}, recentAgents: [] });
  startBrowserAutoSave(); // the shared copy is what the store holds now
  // Another session opens: its model, effort and agent are restored locally.
  withoutSharingModelPrefs(() => {
    useUIStore.getState().addRecentModel('openai', 'restored-other');
    useUIStore.getState().addRecentEffort('openai', 'restored-other', 'low');
    useUIStore.getState().addRecentAgent('restored-agent');
  });
  await wait(PREFS_FLUSH_MS);
  expect(save.mock.calls).toHaveLength(0);
  // Later, Paul explicitly picks X.
  useUIStore.getState().addRecentModel('anthropic', 'picked-x');
  await wait(PREFS_FLUSH_MS);
  expect(save.mock.calls).toHaveLength(1);
  const sent = save.mock.calls[0]?.[0];
  expect(Object.keys(sent ?? {})).toEqual(['recentModels']);
  expect(sent?.recentModels).toEqual([{ providerID: 'anthropic', modelID: 'picked-x' }, { providerID: 'anthropic', modelID: 'shared-a' }]);
  expect(JSON.stringify(sent).includes('restored')).toBe(false);
});

test('an explicit project choice still publishes lastDirectory', () => {
  const path = '/sandbox/f6-project';
  const project: ProjectEntry = { id: createProjectIdFromPath(path), path, label: 'f6', addedAt: 1, lastOpenedAt: 1 };
  useProjectsStore.setState({ projects: [project], activeProjectId: null, managedCatalogAdmitted: false });

  useProjectsStore.getState().setActiveProject(project.id);

  expect(save.mock.calls.some(([changes]) => changes.lastDirectory === path)).toBe(true);
});
