import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as settings from '@/lib/persistence';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import { startModelPrefsAutoSave, type ModelPrefsServer } from '@/lib/modelPrefsAutoSave';
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

/** The server's model preferences: every read returns them with a revision; every write is recorded. */
type Prefs = import('@/lib/modelPrefsShared').ModelPrefs;
const empty = (): Prefs => ({ favoriteModels: [], hiddenModels: [], collapsedModelProviders: [], recentModels: [], recentAgents: [], recentEfforts: {} });
function fakeServer(initial: Partial<Prefs> = {}) {
  const state = { prefs: { ...empty(), ...initial }, etag: 'v1', reads: 0, writes: [] as Array<{ changes: Partial<Prefs>; etag: string | null }>,
    conflictOnce: false };
  const server: ModelPrefsServer = {
    async read() { state.reads += 1; return { prefs: structuredClone(state.prefs), etag: state.etag }; },
    async write(changes, etag) {
      state.writes.push({ changes: structuredClone(changes), etag });
      if (state.conflictOnce || etag !== state.etag) { state.conflictOnce = false; return 'conflict'; }
      state.prefs = { ...state.prefs, ...changes }; state.etag = `v${Number(state.etag.slice(1)) + 1}`;
      return 'ok';
    },
  };
  return { state, server };
}

/** modelPrefsAutoSave runs only in a browser; the timers it needs are the global ones. */
const startBrowserAutoSave = (server: ModelPrefsServer) => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  stopAutoSave = startModelPrefsAutoSave(server);
};
const localPrefs = () => useUIStore.setState({ recentModels: [], recentEfforts: {}, recentAgents: [], favoriteModels: [] });

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

test('opening, sending (the echo restores the session choice) and restoring write nothing', async () => {
  localPrefs();
  const { state, server } = fakeServer();
  startBrowserAutoSave(server);
  withoutSharingModelPrefs(() => {
    useUIStore.getState().addRecentModel('anthropic', 'send-echo');
    useUIStore.getState().addRecentEffort('anthropic', 'send-echo', 'high');
    useUIStore.getState().addRecentAgent('build-f6');
  });
  await wait(PREFS_FLUSH_MS);
  expect(state.reads).toBe(0); expect(state.writes).toHaveLength(0);
  expect(save.mock.calls).toHaveLength(0);
});

test('a restore, then an explicit pick, writes only the picked entry onto the server\'s list', async () => {
  localPrefs();
  const { state, server } = fakeServer({ recentModels: [{ providerID: 'anthropic', modelID: 'server-a' }] });
  startBrowserAutoSave(server);
  withoutSharingModelPrefs(() => useUIStore.getState().addRecentModel('openai', 'restored-other'));
  useUIStore.getState().addRecentModel('anthropic', 'picked-x');
  await wait(PREFS_FLUSH_MS);
  expect(state.writes).toEqual([{ etag: 'v1', changes: { recentModels: [
    { providerID: 'anthropic', modelID: 'picked-x' }, { providerID: 'anthropic', modelID: 'server-a' }] } }]);
});

test('a server value equal to a restored one is kept: an effort pick adds only its effort to the server list', async () => {
  localPrefs();
  const { state, server } = fakeServer({ recentEfforts: { 'anthropic/m': ['low'] } });
  startBrowserAutoSave(server);
  withoutSharingModelPrefs(() => useUIStore.getState().addRecentEffort('anthropic', 'm', 'low'));
  useUIStore.getState().addRecentEffort('anthropic', 'm', 'high');
  await wait(PREFS_FLUSH_MS);
  expect(state.writes.map(write => write.changes)).toEqual([{ recentEfforts: { 'anthropic/m': ['high', 'low'] } }]);
  expect(state.prefs.recentEfforts).toEqual({ 'anthropic/m': ['high', 'low'] });
});

test('a conflict is retried once from a fresh read, keeping what changed meanwhile', async () => {
  localPrefs();
  const { state, server } = fakeServer({ recentModels: [{ providerID: 'p', modelID: 'old' }] });
  startBrowserAutoSave(server);
  useUIStore.getState().addRecentModel('anthropic', 'picked-y');
  // Another client writes before this save lands.
  state.conflictOnce = true;
  const read = server.read.bind(server);
  server.read = async () => {
    const result = await read();
    if (state.reads === 2) { state.prefs.recentModels = [{ providerID: 'p', modelID: 'other-client' }, ...state.prefs.recentModels]; state.etag = 'v9';
      return { prefs: structuredClone(state.prefs), etag: 'v9' }; }
    return result;
  };
  await wait(PREFS_FLUSH_MS + 50);
  expect(state.reads).toBe(2); expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual({ etag: 'v9', changes: { recentModels: [{ providerID: 'anthropic', modelID: 'picked-y' },
    { providerID: 'p', modelID: 'other-client' }, { providerID: 'p', modelID: 'old' }] } });
});

test('saves run one at a time in the user\'s order: a later choice is never undone by an earlier save', async () => {
  localPrefs();
  const { state, server } = fakeServer();
  let releaseFirst!: () => void;
  const held = new Promise<void>(done => { releaseFirst = done; });
  const write = server.write.bind(server);
  server.write = async (changes, etag) => { if (state.writes.length === 0) await held; return write(changes, etag); };
  startBrowserAutoSave(server);
  useUIStore.getState().addRecentModel('anthropic', 'x'); // first choice: its save is held in flight
  await wait(PREFS_FLUSH_MS);
  useUIStore.getState().addRecentModel('anthropic', 'y'); // a later choice
  await wait(PREFS_FLUSH_MS);
  expect(state.reads).toBe(1); // the second save waits for the first
  releaseFirst();
  await wait(100);
  expect(state.prefs.recentModels).toEqual([{ providerID: 'anthropic', modelID: 'y' }, { providerID: 'anthropic', modelID: 'x' }]);
  expect(state.writes.map(entry => entry.etag)).toEqual(['v1', 'v2']);
});

test('a favourite drag is saved in the new order, and only that key', async () => {
  const x = { providerID: 'anthropic', modelID: 'fav-x' }, z = { providerID: 'openai', modelID: 'fav-z' };
  localPrefs(); useUIStore.setState({ favoriteModels: [x, z] });
  const { state, server } = fakeServer({ favoriteModels: [x, z], recentModels: [{ providerID: 'p', modelID: 'kept' }] });
  startBrowserAutoSave(server);
  useUIStore.getState().reorderFavoriteModel('openai', 'fav-z', 'anthropic', 'fav-x');
  await wait(PREFS_FLUSH_MS);
  expect(state.writes.map(entry => entry.changes)).toEqual([{ favoriteModels: [z, x] }]);
  expect(state.prefs.recentModels).toEqual([{ providerID: 'p', modelID: 'kept' }]);
});

test('an explicit project choice still publishes lastDirectory', () => {
  const path = '/sandbox/f6-project';
  const project: ProjectEntry = { id: createProjectIdFromPath(path), path, label: 'f6', addedAt: 1, lastOpenedAt: 1 };
  useProjectsStore.setState({ projects: [project], activeProjectId: null, managedCatalogAdmitted: false });

  useProjectsStore.getState().setActiveProject(project.id);

  expect(save.mock.calls.some(([changes]) => changes.lastDirectory === path)).toBe(true);
});
