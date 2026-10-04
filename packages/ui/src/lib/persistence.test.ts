import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { toast } from 'sonner';

import type { RuntimeAPIs, SettingsAPI, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import {
  DEFAULT_INPUT_HISTORY_LIMIT,
  DEFAULT_INPUT_HISTORY_SCOPE,
} from '@/lib/inputHistoryScope';
import { useInputHistoryStore } from '@/stores/useInputHistoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { createProjectIdFromPath } from '@/lib/projectId';
import {
  applyPersistedHomeDirectoryToWindow,
  deferSettingsWritesUntilLoaded,
  getRuntimeSettingsMirrorStorageKey,
  getSettingsSaveState,
  invalidateSettingsCache,
  refreshDesktopSettings,
  loadDesktopSettings,
  subscribeToSettingsSaveState,
  syncDesktopSettings,
  updateDesktopSettings,
  type SettingsSyncedDetail,
} from './persistence';
import { switchRuntimeEndpoint } from './runtime-switch';
import { SettingsConflictError } from './projectSettingsMerge';

type TestWindow = {
  __OPENCHAMBER_HOME__?: string;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

let createdWindow = false;
let createdLocalStorage = false;
let isolatedRuntimeCounter = 0;
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

// A failed runtime settings API tries HTTP next. Keep that fallback offline in
// this suite instead of waiting for real DNS/network requests to *.example.
beforeEach(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => new Response(null, { status: 503 }),
  });
});

// Each test gets its own runtime identity so an in-flight load or save left
// behind by the previous test is rejected as stale instead of leaking its
// response into this test's stores or server-known values.
const isolateRuntime = (): void => {
  isolatedRuntimeCounter += 1;
  switchRuntimeEndpoint({
    apiBaseUrl: `https://isolated-${isolatedRuntimeCounter}.example`,
    runtimeKey: `isolated-${isolatedRuntimeCounter}`,
  });
};
const originalInputHistoryApplyScope = useInputHistoryStore.getState().applyScope;
const originalInputHistoryApplyEntryLimit = useInputHistoryStore.getState().applyEntryLimit;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }

  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  testWindow.setTimeout ??= setTimeout;
  testWindow.clearTimeout ??= clearTimeout;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const registerSettingsApi = (
  save: SettingsAPI['save'],
  load: () => Promise<{ settings: SettingsPayload; source: 'web' | 'vscode'; revision?: string }> = async () => ({ settings: {}, source: 'web' }),
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load,
      save,
    },
  } as unknown as RuntimeAPIs);
};

const registerSettingsSave = (save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>): void => {
  registerSettingsApi(save);
};

const resetModelPrefsState = (): void => {
  useUIStore.setState({
    favoriteModels: [],
    hiddenModels: [],
    collapsedModelProviders: [],
    recentModels: [],
    recentAgents: [],
    recentEfforts: {},
  });
};

afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  registerRuntimeAPIs(null);
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  } else if (typeof window !== 'undefined') {
    delete getWindow().__OPENCHAMBER_HOME__;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('applyPersistedHomeDirectoryToWindow', () => {
  beforeEach(() => {
    delete getWindow().__OPENCHAMBER_HOME__;
  });

  test('does not overwrite an injected desktop home directory', () => {
    getWindow().__OPENCHAMBER_HOME__ = '/Users/example';

    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__OPENCHAMBER_HOME__).toBe('/Users/example');
  });

  test('uses persisted home when no runtime home was injected', () => {
    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__OPENCHAMBER_HOME__).toBe('/Users/example/projects/app');
  });
});

describe('updateDesktopSettings', () => {
  beforeEach(() => {
    getWindow();
    isolateRuntime();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
    resetModelPrefsState();
    useInputHistoryStore.setState({
      entryLimit: DEFAULT_INPUT_HISTORY_LIMIT,
      scope: DEFAULT_INPUT_HISTORY_SCOPE,
      globalBuckets: {},
      sessionBuckets: {},
      applyEntryLimit: originalInputHistoryApplyEntryLimit,
      applyScope: originalInputHistoryApplyScope,
    });
  });

  test('waits for the debounced settings save to finish before resolving', async () => {
    // Driven by the save's own start and a held finish, not by wall-clock sleeps (deterministic under load).
    let saveStarted = false;
    let saveFinished = false;
    let updateResolved = false;
    let started!: () => void, finish!: () => void;
    const whenStarted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });

    registerSettingsSave(async () => {
      saveStarted = true;
      started();
      await held;
      saveFinished = true;
      return {};
    });

    const update = updateDesktopSettings({
      skillCatalogs: [{ id: 'custom:test', label: 'Test', source: 'owner/repo' }],
    });
    update.then(() => {
      updateResolved = true;
    }).catch(() => {
      updateResolved = true;
    });

    await Promise.resolve();
    expect(saveStarted).toBe(false); // debounced: nothing saved yet
    expect(updateResolved).toBe(false);

    await whenStarted;
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(saveFinished).toBe(false);
    expect(updateResolved).toBe(false); // still waiting for the save to finish

    finish();
    await update;
    expect(saveFinished).toBe(true);
    expect(updateResolved).toBe(true);
  });

  test('coalesces rapid settings updates and resolves every caller after one merged save', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let firstResolved = false;
    let secondResolved = false;

    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      await delay(50);
      return {};
    });

    const first = updateDesktopSettings({ themeVariant: 'dark' });
    first.then(() => {
      firstResolved = true;
    }).catch(() => {
      firstResolved = true;
    });

    await delay(50);

    const second = updateDesktopSettings({ fontSize: 14 });
    second.then(() => {
      secondResolved = true;
    }).catch(() => {
      secondResolved = true;
    });

    await Promise.all([first, second]);

    expect(saveCalls).toEqual([{ themeVariant: 'dark', fontSize: 14 }]);
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  test('publishes saving and saved states for an immediate setting update', async () => {
    const states: string[] = [];
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });

    try {
      await updateDesktopSettings({ useSystemTheme: false, themeVariant: 'light' });
      // Success is silent: the shared state machine maps 'saved' back to 'idle'.
      expect(states).toEqual(['saving', 'idle']);
    } finally {
      unsubscribe();
    }
  });

  test('sanitizes a successful fallback settings response before applying it', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackFetch: typeof fetch = async () => new Response(JSON.stringify({ terminalShell: 'zsh' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      globalThis.fetch = fallbackFetch;
      useUIStore.getState().setTerminalShell('fish');

      await updateDesktopSettings({ terminalShell: 'zsh' });

      expect(useUIStore.getState().terminalShell).toBe('zsh');
      expect(getSettingsSaveState()).toBe('idle');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('applies enterToSendConfigured when it arrives without enterToSend', async () => {
    useUIStore.setState({ enterToSend: false, enterToSendConfigured: false });
    registerSettingsSave(async () => ({ enterToSendConfigured: true }));

    await updateDesktopSettings({ enterToSendConfigured: true });

    expect(useUIStore.getState().enterToSend).toBe(false);
    expect(useUIStore.getState().enterToSendConfigured).toBe(true);
  });

  test('reports an error without applying a malformed fallback settings response', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackFetch: typeof fetch = async () => new Response(JSON.stringify('ok'), {
      headers: { 'Content-Type': 'application/json' },
    });
    const states: string[] = [];
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });
    try {
      globalThis.fetch = fallbackFetch;
      useUIStore.getState().setTerminalShell('fish');

      await updateDesktopSettings({ terminalShell: 'zsh' });

      expect(useUIStore.getState().terminalShell).toBe('fish');
      expect(states).toEqual(['saving', 'error']);
    } finally {
      unsubscribe();
      globalThis.fetch = previousFetch;
    }
  });

  test('retains the first project baseline while using a fresh revision after unrelated preference changes', async () => {
    const conditions: Array<string | undefined> = [];
    const savedProjects: string[][] = [];
    const baseline: NonNullable<SettingsPayload['projects']> = [];
    registerSettingsApi(async (changes, options) => {
      conditions.push(options?.ifMatch);
      savedProjects.push(changes.projects?.map(project => project.path) ?? []);
      return changes;
    }, async () => ({ settings: { projects: [{ id: 'home', path: '/home' }], terminalShell: 'fish' }, source: 'web', revision: '"new-preferences"' }));
    const first = updateDesktopSettings({ projects: [{ id: 'a', path: '/a' }] }, { expectedProjects: baseline });
    baseline.push({ id: 'a', path: '/a' });
    const second = updateDesktopSettings({ projects: [{ id: 'a', path: '/a', label: 'Renamed' }] }, { expectedProjects: baseline });
    await Promise.all([first, second]);
    expect(conditions).toEqual(['"new-preferences"']);
    expect(savedProjects).toEqual([['/home', '/a']]);
  });

  for (const switched of [false, true]) test(`orders complete settings batches without self/future waits, runtime switch=${switched}`, async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://write-order-a.example', runtimeKey: 'write-order-a' });
    const saving = deferred<void>();
    const release = deferred<void>();
    const preference = { pwaAppName: 'Ordered' };
    const a = { id: 'a', path: '/a' }, b = { id: 'b', path: '/b' };
    const firstProject = { projects: [a], activeProjectId: a.id };
    const latestProject = { projects: [a, b], activeProjectId: b.id };
    let server: SettingsPayload = { projects: [] };
    let revision = '"0"';
    const reads: string[] = [];
    const patches: Array<Partial<SettingsPayload>> = [];
    const conditions: Array<string | undefined> = [];
    registerSettingsApi(async (changes, options) => {
      patches.push(structuredClone(changes));
      conditions.push(options?.ifMatch);
      if (patches.length === 1) {
        saving.resolve();
        await release.promise;
      }
      if (changes.projects !== undefined && options?.ifMatch !== revision) {
        throw new SettingsConflictError('Stale baseline');
      }
      server = { ...server, ...changes };
      revision = `"${patches.length}"`;
      return structuredClone(server);
    }, async () => {
      reads.push(revision);
      return { settings: structuredClone(server), source: 'web', revision };
    });
    const syncs: Array<string | null | undefined> = [];
    const listener = (event: Event) => {
      // SAFETY: the owning dispatcher emits SettingsSyncedDetail on this event.
      syncs.push((event as CustomEvent<SettingsSyncedDetail>).detail.settings.activeProjectId);
    };
    getWindow().addEventListener('openchamber:settings-synced', listener);
    const updates: Array<ReturnType<typeof updateDesktopSettings>> = [];
    try {
      updates.push(updateDesktopSettings(preference));
      getWindow().dispatchEvent(new Event('pagehide'));
      await saving.promise;
      updates.push(updateDesktopSettings(firstProject, { expectedProjects: [] }));
      getWindow().dispatchEvent(new Event('pagehide'));
      updates.push(updateDesktopSettings(latestProject, { expectedProjects: [a] }));
      getWindow().dispatchEvent(new Event('pagehide'));
      expect(reads).toEqual([]); // Serializing PUT alone would already have read a stale revision.
      expect(patches).toEqual([preference]);
      if (switched) {
        switchRuntimeEndpoint({ apiBaseUrl: 'https://write-order-b.example', runtimeKey: 'write-order-b' });
        const otherPatches: Array<Partial<SettingsPayload>> = [];
        let otherReads = 0;
        registerSettingsApi(async (changes) => {
          // Save-echo migration may mutate the response, not the recorded sent patch.
          otherPatches.push(structuredClone(changes));
          return structuredClone(changes);
        }, async () => {
          otherReads += 1;
          return { settings: {}, source: 'web', revision: '"other"' };
        });
        const other = updateDesktopSettings({ pwaAppName: 'Other runtime' });
        updates.push(other);
        getWindow().dispatchEvent(new Event('pagehide'));
        await other; // The disconnected runtime's held write must not block this one.
        release.resolve();
        await Promise.all(updates);
        expect(otherPatches).toEqual([{ pwaAppName: 'Other runtime' }]);
        expect(otherReads).toBe(0); // Old queued batches never read or mutate the new runtime.
        expect(reads).toEqual([]);
        expect(patches).toEqual([preference]);
        expect(conditions).toEqual([undefined]);
      } else {
        release.resolve();
        await Promise.all(updates); // Includes later batches: a self/future wait would deadlock.
        expect(reads).toEqual(['"1"', '"2"']);
        expect(patches).toEqual([preference, firstProject, latestProject]);
        expect(conditions).toEqual([undefined, '"1"', '"2"']);
        expect(server).toEqual({ ...preference, ...latestProject });
        expect(syncs).toEqual([b.id, b.id, b.id]);
        expect(getSettingsSaveState()).toBe('idle');
      }
    } finally {
      release.resolve();
      await Promise.all(updates);
      getWindow().removeEventListener('openchamber:settings-synced', listener);
    }
  });

  test('compares project values rather than JSON object key order', async () => {
    let saves = 0;
    registerSettingsApi(async (changes) => { saves += 1; return changes; }, async () => ({
      settings: { projects: [{ path: '/a', id: 'a' }] }, source: 'web', revision: '"current"',
    }));
    await updateDesktopSettings({ projects: [] }, { expectedProjects: [{ id: 'a', path: '/a' }] });
    expect(saves).toBe(1);
  });

  test('does not overwrite externally changed projects', async () => {
    let saves = 0;
    registerSettingsApi(async (changes) => { saves += 1; return changes; }, async () => ({
      settings: { projects: [{ id: 'a', path: '/a', label: 'Server' }] }, source: 'web', revision: '"new-projects"',
    }));
    await updateDesktopSettings({ projects: [{ id: 'a', path: '/a', label: 'Client' }] }, { expectedProjects: [{ id: 'a', path: '/a' }] });
    expect(saves).toBe(0);
    expect(getSettingsSaveState()).toBe('error');
  });

  test('does not mutate after its preflight crosses an A to B to A runtime switch', async () => {
    const loading = deferred<void>();
    const loaded = deferred<{ settings: SettingsPayload; source: 'web'; revision: string }>();
    let saves = 0;
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preflight-a.example', runtimeKey: 'preflight-a' });
    registerSettingsApi(async (changes) => { saves += 1; return changes; }, () => { loading.resolve(); return loaded.promise; });
    const write = updateDesktopSettings({ projects: [] }, { expectedProjects: [] });
    await loading.promise;
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preflight-b.example', runtimeKey: 'preflight-b' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preflight-a.example', runtimeKey: 'preflight-a' });
    loaded.resolve({ settings: { projects: [] }, source: 'web', revision: '"a"' });
    await write;
    expect(saves).toBe(0);
  });

  for (const interruption of ['runtime', 'newer-edit']) test(`project conflict recovery stops for ${interruption}`, async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://conflict-a.example', runtimeKey: 'conflict-a' });
    let loads = 0;
    let projectSaves = 0;
    let newerEdit: ReturnType<typeof updateDesktopSettings> | undefined;
    registerSettingsApi(async (changes) => {
      if (!changes.projects) return changes;
      projectSaves += 1;
      throw new SettingsConflictError('Definite rejection');
    }, async () => {
      loads += 1;
      if (loads === 2) {
        if (interruption === 'runtime') {
          switchRuntimeEndpoint({ apiBaseUrl: 'https://conflict-b.example', runtimeKey: 'conflict-b' });
          switchRuntimeEndpoint({ apiBaseUrl: 'https://conflict-a.example', runtimeKey: 'conflict-a' });
        } else {
          newerEdit = updateDesktopSettings({ terminalShell: 'fish' });
        }
      }
      return { settings: { projects: [] }, source: 'web', revision: loads === 1 ? '"before"' : '"after"' };
    });
    try {
      await updateDesktopSettings({ projects: [{ id: 'a', path: '/a' }] }, { expectedProjects: [] });
      expect(projectSaves).toBe(1);
      expect(loads).toBe(2);
    } finally {
      await newerEdit;
    }
  });

  test('does not replay a rejected current-runtime settings mutation through HTTP', async () => {
    const errorToast = spyOn(toast, 'error');
    const previousFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
      globalThis.fetch = async (input) => {
        requests.push(String(input));
        return Response.json({});
      };
      registerSettingsApi(async () => { throw new Error('Settings changed; stale revision'); },
        async () => ({ settings: { projects: [] }, source: 'web', revision: '"old"' }));
      await updateDesktopSettings({ projects: [{ id: 'a', path: '/a' }] }, { expectedProjects: [] });
      expect(requests).toEqual([]);
      expect(getSettingsSaveState()).toBe('error');
      expect(errorToast.mock.calls).toEqual([['Project changes were not saved', {
        description: 'Refresh to load the latest settings, then try again.',
      }]]);
    } finally {
      errorToast.mockRestore();
      globalThis.fetch = previousFetch;
    }
  });

  test('refuses project writes without revision support but retains legacy preference saves', async () => {
    const saved: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => { saved.push(changes); return changes; },
      async () => ({ settings: { projects: [] }, source: 'web' }));
    await updateDesktopSettings({ projects: [{ id: 'a', path: '/a' }] }, { expectedProjects: [] });
    expect(saved).toEqual([]);
    expect(getSettingsSaveState()).toBe('error');
    await updateDesktopSettings({ terminalShell: 'fish' });
    expect(saved.length).toBe(1);
    expect(saved[0]?.terminalShell).toBe('fish');
    expect(saved[0]?.projects).toBe(undefined);
  });

  test('does not send a conditional project mutation without its original baseline', async () => {
    let saves = 0;
    registerSettingsApi(async (changes) => { saves += 1; return changes; },
      async () => ({ settings: { projects: [] }, source: 'web', revision: '"current"' }));
    await updateDesktopSettings({ projects: [{ id: 'a', path: '/a' }] });
    expect(saves).toBe(0);
    expect(getSettingsSaveState()).toBe('error');
  });

  test('drains a pending save to the previous runtime and ignores its stale response', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-a.example', runtimeKey: 'settings-a' });
    const saveResult = deferred<SettingsPayload>();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave((changes) => {
      saveCalls.push(changes);
      return saveResult.promise;
    });
    const update = updateDesktopSettings({ terminalShell: 'zsh' });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-b.example', runtimeKey: 'settings-b' });
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    useUIStore.getState().setTerminalShell('fish');

    expect(saveCalls).toEqual([{ terminalShell: 'zsh' }]);
    saveResult.resolve({ terminalShell: 'zsh' });
    await update;

    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('does not retry a failed old-runtime save against the new runtime', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackRequests: string[] = [];
    const saveResult = deferred<SettingsPayload>();
    try {
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === 'PUT' && url.includes('/api/config/settings')) fallbackRequests.push(url);
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-a.example', runtimeKey: 'failed-save-a' });
      registerSettingsSave(() => saveResult.promise);
      const update = updateDesktopSettings({ terminalShell: 'zsh' });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-b.example', runtimeKey: 'failed-save-b' });
      registerSettingsSave(async (changes) => changes as SettingsPayload);
      saveResult.reject(new Error('runtime A disconnected'));
      await update;

      expect(fallbackRequests).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('external invalidation waits for older bootstrap publication then loads fresh settings', async () => {
    const firstLoad = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    let loads = 0;
    registerSettingsApi(async (changes) => changes, async () => {
      loads += 1;
      return loads === 1 ? firstLoad.promise : { settings: { terminalShell: 'fish' }, source: 'web' };
    });
    invalidateSettingsCache();
    const bootstrap = syncDesktopSettings();
    const refresh = refreshDesktopSettings();
    expect(loads).toBe(1);
    firstLoad.resolve({ settings: { terminalShell: 'bash' }, source: 'web' });
    await Promise.all([bootstrap, refresh]);
    expect(loads).toBe(2);
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('external invalidation waits for a pending save echo before loading the newer snapshot', async () => {
    const saving = deferred<void>();
    const saved = deferred<SettingsPayload>();
    let saves = 0;
    let loads = 0;
    registerSettingsApi(async (changes) => {
      saves += 1;
      if (saves !== 1) return changes;
      saving.resolve();
      return saved.promise;
    }, async () => { loads += 1; return { settings: { terminalShell: 'fish' }, source: 'web' }; });
    const write = updateDesktopSettings({ gitChangesViewMode: 'tree' });
    const refresh = refreshDesktopSettings();
    await saving.promise;
    expect(loads).toBe(0);
    saved.resolve({ terminalShell: 'bash' });
    await Promise.all([write, refresh]);
    expect(loads).toBe(1);
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('external invalidation does not wait for requests belonging to a disconnected runtime', async () => {
    const oldLoad = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://waiting-old.example', runtimeKey: 'waiting-old' });
    registerSettingsApi(async (changes) => changes, () => oldLoad.promise);
    const oldSync = syncDesktopSettings();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://waiting-new.example', runtimeKey: 'waiting-new' });
    registerSettingsApi(async (changes) => changes, async () => ({ settings: { terminalShell: 'fish' }, source: 'web' }));
    await refreshDesktopSettings();
    oldLoad.resolve({ settings: { terminalShell: 'bash' }, source: 'web' });
    await oldSync;
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('external invalidation does not follow an old runtime into the next runtime', async () => {
    const oldLoad = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-old.example', runtimeKey: 'refresh-old' });
    registerSettingsApi(async (changes) => changes, () => oldLoad.promise);
    const bootstrap = syncDesktopSettings();
    const refresh = refreshDesktopSettings();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-new.example', runtimeKey: 'refresh-new' });
    let newLoads = 0;
    registerSettingsApi(async (changes) => changes, async () => {
      newLoads += 1;
      return { settings: {}, source: 'web' };
    });
    oldLoad.resolve({ settings: { terminalShell: 'bash' }, source: 'web' });
    await Promise.all([bootstrap, refresh]);
    expect(newLoads).toBe(0);
  });

  test('rejects stale loads by generation across an A to B to A switch', async () => {
    const originalLoad = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), () => originalLoad.promise);
    const firstSync = syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-b.example', runtimeKey: 'load-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'fish', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'bash', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('bash');

    originalLoad.resolve({
      settings: { terminalShell: 'zsh', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    });
    await firstSync;
    expect(useUIStore.getState().terminalShell).toBe('bash');
  });

  test('isolates local settings mirrors and removes values omitted by the next runtime', async () => {
    getWindow();
    localStorage.clear();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-a.example', runtimeKey: 'mirror-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        themeId: 'theme-a',
        directoryShowHidden: true,
        sttModel: 'model-a',
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-b.example', runtimeKey: 'mirror-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(localStorage.getItem('selectedThemeId')).toBeNull();
    expect(localStorage.getItem('directoryTreeShowHidden')).toBeNull();
    expect(localStorage.getItem('sttModel')).toBeNull();
    // The mirror carries every user-owned field the server returned, so the
    // draft-starter markers ride along with the three values under test.
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-a')) ?? '{}')).toEqual({
      themeId: 'theme-a',
      directoryShowHidden: true,
      sttModel: 'model-a',
      draftStartersCraftGoalAdded: true,
      draftStartersScheduleTaskAdded: true,
    });
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-b')) ?? '{}')).toEqual({
      draftStartersCraftGoalAdded: true,
      draftStartersScheduleTaskAdded: true,
    });
  });

  test('keeps in-memory preferences that an authoritative runtime snapshot omits', async () => {
    getWindow();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-a.example', runtimeKey: 'preferences-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        toolJsonViewMode: 'raw',
        followUpBehavior: 'steer',
        draftStarters: [{ type: 'command', name: 'runtime-a' }],
        draftStartersVisible: false,
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().toolJsonViewMode).toBe('raw');
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useUIStore.getState().draftStartersVisible).toBe(false);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-b.example', runtimeKey: 'preferences-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    // An omitted key is "unset", not "reset to default": the window keeps what
    // it holds and nothing is written back.
    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().toolJsonViewMode).toBe('raw');
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useUIStore.getState().draftStartersVisible).toBe(false);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');
  });

  test('treats settings save responses as partial patches', async () => {
    getWindow();
    localStorage.setItem('selectedThemeId', 'existing-theme');
    useUIStore.getState().setTerminalShell('fish');
    registerSettingsSave(async () => ({ showReasoningTraces: false }));

    await updateDesktopSettings({ showReasoningTraces: false });

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(localStorage.getItem('selectedThemeId')).toBe('existing-theme');
  });

  test('ignores an invalid JSON view mode in a settings save response', async () => {
    getWindow();
    useUIStore.getState().setToolJsonViewMode('formatted');
    const invalidSettings: SettingsPayload = {};
    Object.defineProperty(invalidSettings, 'toolJsonViewMode', { value: 'invalid', enumerable: true });
    registerSettingsSave(async () => invalidSettings);

    await updateDesktopSettings({ showReasoningTraces: false });

    expect(useUIStore.getState().toolJsonViewMode).toBe('formatted');
  });

  test('applies authoritative shared sidebar preferences without replacing local-only sidebar state', async () => {
    getWindow();
    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      sessionGroupingMode: 'by-worktree',
      projectSortOrder: 'manual',
      showRecentSection: true,
      singleProjectId: 'local-project',
      stickyZoneHeaders: false,
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        sidebarProjectDisplayMode: 'single',
        sidebarSessionGroupingMode: 'flat',
        sidebarProjectSortOrder: 'recent',
        sidebarShowRecentSection: false,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
      singleProjectId: state.singleProjectId,
      stickyZoneHeaders: state.stickyZoneHeaders,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'recent',
      showRecentSection: false,
      singleProjectId: 'local-project',
      stickyZoneHeaders: false,
    });
  });

  // smarty-code#117: this browser's local sidebar preferences are kept in memory, never published by a page load.
  test('keeps local sidebar preferences the shared settings lack, without writing them', async () => {
    getWindow();
    const saves: Array<Partial<SettingsPayload>> = [];
    useSessionDisplayStore.setState({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'a-z',
      showRecentSection: false,
    });
    registerSettingsApi(async (changes) => {
      saves.push(changes);
      return changes;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();
    await delay(300);

    expect(saves).toEqual([]);
    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'a-z',
      showRecentSection: false,
    });
  });

  test('preserves local sidebar preferences when the authoritative load fails', async () => {
    getWindow();
    useSessionDisplayStore.setState({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'z-a',
      showRecentSection: false,
    });
    registerSettingsApi(async () => ({}), async () => {
      throw new Error('offline');
    });

    await syncDesktopSettings();

    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'z-a',
      showRecentSection: false,
    });
  });

  test('applies validated input history scope from shared settings save responses', async () => {
    getWindow();
    registerSettingsSave(async () => ({ inputHistoryScope: 'session' }));

    await updateDesktopSettings({ inputHistoryScope: 'session' });

    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('applies validated input history limit from shared settings save responses', async () => {
    getWindow();
    registerSettingsSave(async () => ({ inputHistoryLimit: 100 }));

    await updateDesktopSettings({ inputHistoryLimit: 100 });

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('does not broadcast a stale project selection over a newer pending update', async () => {
    const firstSave = deferred<SettingsPayload>();
    const savedChanges: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      savedChanges.push(changes);
      if (savedChanges.length === 1) return firstSave.promise;
      return changes as SettingsPayload;
    });
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const firstUpdate = updateDesktopSettings({ activeProjectId: 'project-a' });
      await delay(250);
      const secondUpdate = updateDesktopSettings({ activeProjectId: 'project-b' });

      firstSave.resolve({ activeProjectId: 'project-a' });
      await firstUpdate;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');

      await secondUpdate;
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  for (const conflict of [false, true]) test(`bootstrap during project save preserves selection with unrelated conflict=${conflict}`, async () => {
    const home = { id: createProjectIdFromPath('/fixture/home'), path: '/fixture/home', label: 'Home', addedAt: 1, lastOpenedAt: 1 };
    const projectPath = '/fixture/project';
    const display = useSessionDisplayStore.getState();
    let server: SettingsPayload = {
      projects: [home], activeProjectId: home.id, lastDirectory: home.path, pwaAppName: 'Baseline',
      autoSaveEnabled: true, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      sidebarProjectDisplayMode: display.projectDisplayMode, sidebarSessionGroupingMode: display.sessionGroupingMode,
      sidebarProjectSortOrder: display.projectSortOrder, sidebarShowRecentSection: display.showRecentSection,
    };
    const saving = deferred<void>();
    const releaseSave = deferred<void>();
    let revision = '"before"';
    const conditions: Array<string | undefined> = [];
    let writeInFlight = false;
    let readsDuringWrite = 0;
    registerSettingsApi(async (changes, options) => {
      conditions.push(options?.ifMatch);
      expect(options?.ifMatch).toBe(revision);
      writeInFlight = true;
      saving.resolve();
      await releaseSave.promise;
      writeInFlight = false;
      if (conflict && conditions.length === 1) {
        server = { ...server, pwaAppName: 'Concurrent preference' };
        revision = '"after-unrelated"';
        throw new SettingsConflictError('Settings changed');
      }
      server = { ...server, ...changes };
      return server;
    }, async () => {
      if (writeInFlight) readsDuringWrite += 1;
      return { settings: structuredClone(server), source: 'web', revision };
    });
    useProjectsStore.setState({ projects: [home], activeProjectId: home.id, manualProjectOrder: [], managedCatalogStatus: 'stock' });
    useDirectoryStore.setState({ currentDirectory: home.path, homeDirectory: home.path });
    opencodeClient.setDirectory(home.path);
    const transitions: string[] = [];
    const unsubscribe = useDirectoryStore.subscribe((state) => transitions.push(state.currentDirectory));
    const syncs: SettingsSyncedDetail[] = [];
    const listener = (event: Event) => {
      // SAFETY: the owning dispatcher emits SettingsSyncedDetail on this event.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      syncs.push(detail);
      // Same consumer as useProjectsStore's browser event listener.
      useProjectsStore.getState().synchronizeFromSettings(detail.settings, { adoptActiveProject: detail.bootstrap });
    };
    getWindow().addEventListener('openchamber:settings-synced', listener);
    // The disposable project has no icon. No HTTP server or provider runs here.
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    let bootstrap: Promise<void> | undefined;
    try {
      const project = await useProjectsStore.getState().addProject(projectPath);
      expect(project?.path).toBe(projectPath);
      await saving.promise;
      bootstrap = syncDesktopSettings();
      // Release at the next task: a read already started sees the old server snapshot.
      await delay(0);
      releaseSave.resolve();
      await bootstrap;
      const published = syncs.filter((detail) => detail.bootstrap).at(-1)?.settings;
      expect(published?.projects?.map((entry) => entry.path)).toEqual([home.path, projectPath]);
      expect(published?.activeProjectId).toBe(project?.id);
      expect(readsDuringWrite).toBe(0);
      expect(conditions).toEqual(conflict ? ['"before"', '"after-unrelated"'] : ['"before"']);
      expect(server.pwaAppName).toBe(conflict ? 'Concurrent preference' : 'Baseline');
      expect(server.projects?.map((entry) => entry.path)).toEqual([home.path, projectPath]);
      expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual([home.path, projectPath]);
      expect(useDirectoryStore.getState().currentDirectory).toBe(projectPath);
      expect(opencodeClient.getDirectory()).toBe(projectPath);
      expect(transitions).not.toContain(home.path);
    } finally {
      releaseSave.resolve();
      await bootstrap;
      unsubscribe();
      getWindow().removeEventListener('openchamber:settings-synced', listener);
      fetch.mockRestore();
    }
  });

  for (const completion of ['before', 'after']) test(`bootstrap after a project save does not reuse a pre-save read resolved ${completion} it starts`, async () => {
    const home = { id: createProjectIdFromPath('/fixture/home'), path: '/fixture/home', label: 'Home', addedAt: 1, lastOpenedAt: 1 };
    const projectPath = '/fixture/project';
    const display = useSessionDisplayStore.getState();
    let server: SettingsPayload = {
      projects: [home], activeProjectId: home.id, lastDirectory: home.path,
      autoSaveEnabled: true, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      sidebarProjectDisplayMode: display.projectDisplayMode, sidebarSessionGroupingMode: display.sessionGroupingMode,
      sidebarProjectSortOrder: display.projectSortOrder, sidebarShowRecentSection: display.showRecentSection,
    };
    const reading = deferred<void>();
    const releaseRead = deferred<void>();
    const saved = deferred<void>();
    let loads = 0;
    registerSettingsApi(async (changes, options) => {
      if (changes.projects) expect(options?.ifMatch).toBe('"before"');
      server = { ...server, ...changes };
      return server;
    }, async () => {
      const settings = structuredClone(server);
      loads += 1;
      if (loads === 1) {
        reading.resolve();
        await releaseRead.promise;
      }
      return { settings, source: 'web', revision: '"before"' };
    });
    useProjectsStore.setState({ projects: [home], activeProjectId: home.id, manualProjectOrder: [], managedCatalogStatus: 'stock' });
    useDirectoryStore.setState({ currentDirectory: home.path, homeDirectory: home.path });
    opencodeClient.setDirectory(home.path);
    const transitions: string[] = [];
    const unsubscribe = useDirectoryStore.subscribe((state) => transitions.push(state.currentDirectory));
    const unsubscribeSave = subscribeToSettingsSaveState(() => { if (getSettingsSaveState() === 'idle') saved.resolve(); });
    const listener = (event: Event) => {
      // SAFETY: the owning dispatcher emits SettingsSyncedDetail on this event.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      useProjectsStore.getState().synchronizeFromSettings(detail.settings, { adoptActiveProject: detail.bootstrap });
    };
    getWindow().addEventListener('openchamber:settings-synced', listener);
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const first = syncDesktopSettings();
    let second: Promise<void> | undefined;
    try {
      await reading.promise;
      const project = await useProjectsStore.getState().addProject(projectPath);
      expect(project?.path).toBe(projectPath);
      await saved.promise;
      if (completion === 'before') {
        releaseRead.resolve();
        await first;
      }
      second = syncDesktopSettings();
      await delay(0);
      releaseRead.resolve();
      await Promise.all([first, second]);
      expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual([home.path, projectPath]);
      expect(useProjectsStore.getState().activeProjectId).toBe(project?.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(projectPath);
      expect(opencodeClient.getDirectory()).toBe(projectPath);
      expect(transitions).not.toContain(home.path);
      expect(loads).toBe(3); // Pre-save bootstrap, conditional-write baseline, post-save bootstrap.
      await syncDesktopSettings();
      expect(loads).toBe(3); // The valid post-save snapshot remains cached.
      expect(useDirectoryStore.getState().currentDirectory).toBe(projectPath);
      expect(transitions).not.toContain(home.path);
    } finally {
      releaseRead.resolve();
      await Promise.all([first, second]);
      // Drain navigation persistence triggered by the consumer, including failed assertions.
      await updateDesktopSettings({});
      unsubscribe();
      unsubscribeSave();
      getWindow().removeEventListener('openchamber:settings-synced', listener);
      fetch.mockRestore();
    }
  });

  for (const transport of ['runtime', 'http']) test(`settings invalidation preserves newer in-flight dedup and cache via ${transport}`, async () => {
    const display = useSessionDisplayStore.getState();
    const settings: SettingsPayload = {
      autoSaveEnabled: true, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      sidebarProjectDisplayMode: display.projectDisplayMode, sidebarSessionGroupingMode: display.sessionGroupingMode,
      sidebarProjectSortOrder: display.projectSortOrder, sidebarShowRecentSection: display.showRecentSection,
    };
    const reading = deferred<void>();
    const releaseOld = deferred<void>();
    const releaseNew = deferred<void>();
    let loads = 0;
    const startRead = () => {
      const old = ++loads === 1;
      reading.resolve();
      const snapshot: SettingsPayload = { ...settings, terminalShell: old ? 'bash' : 'fish' };
      return { snapshot, ready: old ? releaseOld.promise : releaseNew.promise };
    };
    if (transport === 'runtime') registerSettingsApi(async (changes) => changes, async () => {
      const { snapshot, ready } = startRead();
      await ready;
      return { settings: snapshot, source: 'web' };
    });
    // Headers settle before the body, beyond runtimeFetch's transport-level dedup.
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const { snapshot, ready } = startRead();
      return new Response(new ReadableStream({ async start(controller) {
        await ready;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot)));
        controller.close();
      } }));
    });
    const first = syncDesktopSettings();
    let second: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    try {
      await reading.promise;
      await delay(0); // Let response headers settle before invalidating the pending body read.
      invalidateSettingsCache();
      second = syncDesktopSettings();
      await delay(0);
      releaseOld.resolve();
      await first;
      let thirdFinished = false;
      third = syncDesktopSettings().then(() => { thirdFinished = true; });
      await delay(0);
      expect(thirdFinished).toBe(false); // The detached old response is not a cache hit.
      expect(loads).toBe(2); // Its cleanup did not detach the newer pending read.
      releaseNew.resolve();
      await Promise.all([second, third]);
      expect(useUIStore.getState().terminalShell).toBe('fish');
      await syncDesktopSettings();
      expect(loads).toBe(2);
      expect(useUIStore.getState().terminalShell).toBe('fish');
    } finally {
      releaseOld.resolve();
      releaseNew.resolve();
      await Promise.all([first, second, third]);
      fetch.mockRestore();
    }
  });

  test('bootstrap does not replay a rejected outstanding write', async () => {
    const saving = deferred<void>();
    const releaseSave = deferred<void>();
    let saves = 0;
    let loads = 0;
    registerSettingsApi(async () => {
      saves += 1;
      saving.resolve();
      await releaseSave.promise;
      throw new Error('conditional write rejected');
    }, async () => {
      loads += 1;
      return { settings: { terminalShell: 'bash', autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
        sidebarProjectDisplayMode: useSessionDisplayStore.getState().projectDisplayMode,
        sidebarSessionGroupingMode: useSessionDisplayStore.getState().sessionGroupingMode,
        sidebarProjectSortOrder: useSessionDisplayStore.getState().projectSortOrder,
        sidebarShowRecentSection: useSessionDisplayStore.getState().showRecentSection }, source: 'web' };
    });
    const write = updateDesktopSettings({ terminalShell: 'fish' });
    await saving.promise;
    const bootstrap = syncDesktopSettings();
    try {
      await delay(0);
      expect(loads).toBe(0);
    } finally {
      releaseSave.resolve();
      await Promise.all([write, bootstrap]);
    }
    expect(saves).toBe(1);
    expect(loads).toBe(1);
    expect(useUIStore.getState().terminalShell).toBe('bash');
  });

  test('bootstrap waiting on a write cannot follow a runtime switch', async () => {
    const saving = deferred<void>();
    const releaseSave = deferred<void>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://pending-write-a.example', runtimeKey: 'pending-write-a' });
    registerSettingsApi(async (changes) => {
      saving.resolve();
      await releaseSave.promise;
      return changes;
    });
    const write = updateDesktopSettings({ terminalShell: 'fish' });
    await saving.promise;
    const oldBootstrap = syncDesktopSettings();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://pending-write-b.example', runtimeKey: 'pending-write-b' });
    let loads = 0;
    registerSettingsApi(async (changes) => changes, async () => {
      loads += 1;
      return { settings: { terminalShell: 'bash', autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true }, source: 'web' };
    });
    try {
      await syncDesktopSettings();
      expect(loads).toBe(1); // Disconnected runtime's write does not delay this runtime.
    } finally {
      releaseSave.resolve();
      await Promise.all([write, oldBootstrap]);
    }
    expect(loads).toBe(1); // Old waiter never loads the new runtime.
    expect(useUIStore.getState().terminalShell).toBe('bash');
  });

  test('does not broadcast a stale loaded project selection over a newer pending update', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const update = updateDesktopSettings({ activeProjectId: 'project-b' });

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'project-a',
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');

      await update;
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  test('does not broadcast a stale load after a newer project update has saved', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const update = updateDesktopSettings({ activeProjectId: 'project-b' });
      await update;

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'project-a',
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  for (const flushed of [false, true]) {
    test(`preserves navigation during bootstrap migration, newer batch flushed: ${flushed}`, async () => {
      const migrationStarted = deferred<void>();
      const releaseMigration = deferred<void>();
      registerSettingsApi(async (changes) => {
        // The draft-starter migration of a legacy list (it changes the list, so it writes once; #117).
        if (changes.draftStartersCraftGoalAdded !== undefined) {
          migrationStarted.resolve();
          await releaseMigration.promise;
        }
        return changes;
      }, async () => ({ settings: { activeProjectId: 'project-a', draftStarters: [{ type: 'command', name: 'plan-feature' }] }, source: 'web' }));
      invalidateSettingsCache();
      const synced: SettingsSyncedDetail[] = [];
      const handleSettingsSynced = (event: Event) => {
        // SAFETY: the settings-synced emitter sends SettingsSyncedDetail.
        synced.push((event as CustomEvent<SettingsSyncedDetail>).detail);
      };
      getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

      const sync = syncDesktopSettings();
      await migrationStarted.promise;
      const navigation = updateDesktopSettings({ activeProjectId: 'project-b', showReasoningTraces: false });
      try {
        // Later writes cannot finish before the held predecessor. Cover both buffer and queued batch.
        if (flushed) getWindow().dispatchEvent(new Event('pagehide'));
        releaseMigration.resolve();
        await sync;
        const bootstrap = synced.filter((detail) => detail.bootstrap).at(-1);
        expect(bootstrap?.settings.activeProjectId).toBe('project-b');
        expect(bootstrap?.settings.showReasoningTraces).toBe(false);
      } finally {
        releaseMigration.resolve();
        await navigation;
        getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
      }
    });
  }

  test('preserves only the latest settings values across repeated pending updates', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const updates = Array.from({ length: 100 }, (_, index) => updateDesktopSettings({
        activeProjectId: `project-${index}`,
        showReasoningTraces: index % 2 === 0,
      }));

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'stale-project',
          showReasoningTraces: true,
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-99');
      expect(syncedSettings.at(-1)?.showReasoningTraces).toBe(false);

      await Promise.all(updates);
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  test('applies model selector settings from server settings', async () => {
    getWindow();
    const settings = {
      favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
      hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
      collapsedModelProviders: ['anthropic', 'openai'],
      recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
      recentAgents: ['build', 'plan'],
      recentEfforts: { 'anthropic/claude-haiku-4': ['high', 'default'] },
      draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
    } satisfies SettingsPayload;
    registerSettingsApi(async () => ({}), async () => ({ settings, source: 'web' }));

    await syncDesktopSettings();

    const state = useUIStore.getState();
    expect(state.favoriteModels).toEqual(settings.favoriteModels);
    expect(state.hiddenModels).toEqual(settings.hiddenModels);
    expect(state.collapsedModelProviders).toEqual(settings.collapsedModelProviders);
    expect(state.recentModels).toEqual(settings.recentModels);
    expect(state.recentAgents).toEqual(settings.recentAgents);
    expect(state.recentEfforts).toEqual(settings.recentEfforts);
  });

  test('applies the persisted terminal shell from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'zsh', terminalLoginShells: ['zsh', 'fish'] },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().terminalShell).toBe('zsh');
    expect(useUIStore.getState().terminalLoginShells).toEqual(['zsh', 'fish']);
  });

  test('autosaves all model selector settings fields', async () => {
    getWindow();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    const stop = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      await delay(20);
      useUIStore.setState({
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });

      // Wait for the save itself (the debounce and the queued read), bounded, not a fixed sleep.
      for (let waited = 0; saveCalls.length === 0 && waited < 10_000; waited += 20) await delay(20);
      await delay(50); // a second save, if any, would follow within the same queue turn

      // Each explicit change is written as exactly the keys it touched, onto the server's copy (smarty-code#126 F6).
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]).toEqual({
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });
    } finally {
      stop();
    }
  });

  test('autosaves the first model preference change', async () => {
    getWindow();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    const stop = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      await delay(1300);

      expect(saveCalls).toEqual([{
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
      }]);
    } finally {
      stop();
    }
  });

  test('autosaves appearance preferences to shared settings', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    useUIStore.getState().setToolJsonViewMode('summary');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setTerminalShell('zsh');
    useUIStore.getState().setTerminalLoginShells(['zsh']);
    useUIStore.getState().setToolJsonViewMode('formatted');
    await delay(500);

    expect(saveCalls.some((changes) => changes.terminalShell === 'zsh')).toBe(true);
    expect(saveCalls.some((changes) => changes.terminalLoginShells?.includes('zsh'))).toBe(true);
    expect(saveCalls.some((changes) => changes.toolJsonViewMode === 'formatted')).toBe(true);
  });

  test('legacy server lists show telemetry, while explicit hiding survives hydration', async () => {
    getWindow();
    for (const explicit of [undefined, false, true]) {
      invalidateSettingsCache();
      registerSettingsApi(async (changes) => changes, async () => ({
        settings: { workStatusHiddenSections: ['mcp', 'telemetry'], workStatusHiddenSectionsExplicit: explicit,
          draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
        source: 'web',
      }));
      await syncDesktopSettings();
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(explicit ? ['mcp', 'telemetry'] : ['mcp']);
      expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(explicit === true);
    }
  });

  test('autosaves telemetry hiding and its list together, then restores them through settings load', async () => {
    getWindow();
    invalidateSettingsCache();
    let server: SettingsPayload = { workStatusHiddenSections: [], draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true };
    const saves: Partial<SettingsPayload>[] = [];
    registerSettingsApi(async (changes) => { saves.push(changes); server = { ...server, ...changes }; return changes; },
      async () => ({ settings: server, source: 'web' }));
    await syncDesktopSettings();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual([]);
    startAppearanceAutoSave();
    useUIStore.getState().setWorkStatusSectionVisible('telemetry', false);
    await delay(600);
    expect(saves.some((changes) => changes.workStatusHiddenSectionsExplicit === true)).toBe(true);
    expect(server.workStatusHiddenSections).toEqual(['telemetry']);
    expect(server.workStatusHiddenSectionsExplicit).toBe(true);
    invalidateSettingsCache();
    await syncDesktopSettings();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['telemetry']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
    // An unrelated partial save response must not re-enable a hidden section.
    await updateDesktopSettings({ workStatusPanelEnabled: useUIStore.getState().workStatusPanelEnabled });
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['telemetry']);
  });

  test('applies persisted autoSaveEnabled from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(true);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { autoSaveEnabled: false, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().autoSaveEnabled).toBe(false);
  });

  test('applies persisted input history scope from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryScope: 'session',
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('applies persisted input history limit from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryLimit: 100,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('keeps the hydrated input history scope when the server omits it and writes nothing', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyScope('session');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().scope).toBe('session');
    expect(saveCalls.some((changes) => changes.inputHistoryScope !== undefined)).toBe(false);
  });

  test('keeps the hydrated input history limit when the server omits it and writes nothing', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyEntryLimit(100);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
    expect(saveCalls.some((changes) => changes.inputHistoryLimit !== undefined)).toBe(false);
  });

  test('does not reapply the hydrated input history scope when it already matches', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyScope('session');
    let applyScopeCalls = 0;
    useInputHistoryStore.setState({
      applyScope: (scope) => {
        applyScopeCalls += 1;
        originalInputHistoryApplyScope(scope);
      },
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryScope: 'session',
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    try {
      await syncDesktopSettings();
    } finally {
      useInputHistoryStore.setState({ applyScope: originalInputHistoryApplyScope });
    }

    expect(applyScopeCalls).toBe(0);
    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('does not reapply the hydrated input history limit when it already matches', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyEntryLimit(100);
    let applyEntryLimitCalls = 0;
    useInputHistoryStore.setState({
      applyEntryLimit: (limit) => {
        applyEntryLimitCalls += 1;
        originalInputHistoryApplyEntryLimit(limit);
      },
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryLimit: 100,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    try {
      await syncDesktopSettings();
    } finally {
      useInputHistoryStore.setState({ applyEntryLimit: originalInputHistoryApplyEntryLimit });
    }

    expect(applyEntryLimitCalls).toBe(0);
    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('autosaves autoSaveEnabled changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setAutoSaveEnabled(true);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setAutoSaveEnabled(false);
    await delay(500);

    expect(saveCalls.some((changes) => changes.autoSaveEnabled === false)).toBe(true);
  });

  test('keeps an omitted autoSaveEnabled from the hydrated client preference, without writing it (#117)', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(false);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));

    await syncDesktopSettings();
    await delay(500);

    expect(useUIStore.getState().autoSaveEnabled).toBe(false);
    expect(saveCalls).toEqual([]);
  });

  test('a bootstrap that adopts server values produces zero writes even with the auto-savers running', async () => {
    getWindow();
    invalidateSettingsCache();
    // The setup below is itself "a person changing things" as far as the
    // auto-savers can tell; let those writes drain before recording.
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let recording = false;
    registerSettingsApi(async (changes) => {
      if (recording) saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        // A legacy list the client normalises on read: the normalised copy is
        // still not this window's change and must not be written back.
        workStatusHiddenSections: ['mcp', 'telemetry'],
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    startAppearanceAutoSave();
    const stopModelPrefs = startModelPrefsAutoSave();
    useUIStore.getState().setShowReasoningTraces(true);
    useUIStore.getState().setTerminalShell('auto');
    resetModelPrefsState();
    await delay(1500);
    recording = true;

    try {
      await syncDesktopSettings();
      await delay(1500);

      expect(useUIStore.getState().showReasoningTraces).toBe(false);
      expect(useUIStore.getState().terminalShell).toBe('fish');
      expect(useUIStore.getState().favoriteModels).toHaveLength(1);
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
      expect(saveCalls).toEqual([]);
    } finally {
      stopModelPrefs();
    }
  });

  test('drops a write whose value the server already holds', async () => {
    getWindow();
    invalidateSettingsCache();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { fontSize: 15, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    await updateDesktopSettings({ fontSize: 15 });
    expect(saveCalls).toEqual([]);
    expect(getSettingsSaveState()).toBe('idle');

    await updateDesktopSettings({ fontSize: 16 });
    expect(saveCalls).toEqual([{ fontSize: 16 }]);
  });

  test('reconciles warm cached reads with pending and in-flight settings writes', async () => {
    const saveResult = deferred<SettingsPayload>();
    const savedSettings = { defaultModel: 'provider/new-model' } satisfies SettingsPayload;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return saveResult.promise;
      },
      async () => ({
        settings: { defaultModel: 'provider/old-model' },
        source: 'web',
      }),
    );

    const initialSettings = await loadDesktopSettings();
    expect(initialSettings?.defaultModel).toBe('provider/old-model');
    const update = updateDesktopSettings({ defaultModel: 'provider/new-model' });

    const pendingSettings = await loadDesktopSettings();
    expect(pendingSettings?.defaultModel).toBe('provider/new-model');
    await delay(250);
    expect(saveCalls).toEqual([{ defaultModel: 'provider/new-model' }]);
    const inFlightSettings = await loadDesktopSettings();
    expect(inFlightSettings?.defaultModel).toBe('provider/new-model');

    saveResult.resolve(savedSettings);
    await update;
  });

  test('a delayed read retains an edit whose write finishes before the read', async () => {
    const readResult = deferred<{ settings: SettingsPayload; source: 'web' }>();
    const newDefaults = { defaultModel: 'provider/new', defaultVariant: 'high', defaultAgent: 'review' };
    const writes: Array<Partial<SettingsPayload>> = [];
    let reads = 0;
    registerSettingsApi(async (changes) => { writes.push(changes); return { ...changes }; }, () => {
      reads += 1;
      return reads === 1 ? readResult.promise : Promise.resolve({ settings: { ...newDefaults }, source: 'web' as const });
    });
    const update = updateDesktopSettings(newDefaults);
    const read = loadDesktopSettings();
    await update;
    readResult.resolve({ settings: { defaultModel: 'provider/old', defaultVariant: 'low', defaultAgent: 'build' }, source: 'web' });
    expect(await read).toMatchObject(newDefaults);
    expect(await loadDesktopSettings()).toMatchObject(newDefaults);
    expect(reads).toBe(2); // A pre-save read cannot refill the post-save cache.
    await updateDesktopSettings({ defaultModel: 'provider/old' });
    expect(writes).toHaveLength(2);
  });

  test('a read started before an edit cannot undo its completed write', async () => {
    const readResult = deferred<{ settings: SettingsPayload; source: 'web' }>();
    let reads = 0;
    registerSettingsApi(async (changes) => ({ ...changes }), () => {
      reads += 1;
      return reads === 1 ? readResult.promise : Promise.resolve({ settings: { defaultModel: 'provider/new' }, source: 'web' as const });
    });
    const read = loadDesktopSettings();
    await updateDesktopSettings({ defaultModel: 'provider/new' });
    readResult.resolve({ settings: { defaultModel: 'provider/old' }, source: 'web' });
    expect((await read)?.defaultModel).toBe('provider/new');
    expect((await loadDesktopSettings())?.defaultModel).toBe('provider/new');
    expect(reads).toBe(2);
  });

  test('toggling back to the server value inside the debounce window cancels the pending write', async () => {
    getWindow();
    invalidateSettingsCache();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { showDeletionDialog: true, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    void updateDesktopSettings({ showDeletionDialog: false, fontSize: 17 });
    await updateDesktopSettings({ showDeletionDialog: true });

    expect(saveCalls).toEqual([{ fontSize: 17 }]);
  });

  test('a failed save forgets its optimistic value so the retry is sent', async () => {
    getWindow();
    invalidateSettingsCache();
    let fail = true;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      if (fail) throw new Error('offline');
      return { ...changes } as SettingsPayload;
    });

    await updateDesktopSettings({ fontSize: 18 });
    fail = false;
    await updateDesktopSettings({ fontSize: 18 });

    expect(saveCalls).toEqual([{ fontSize: 18 }, { fontSize: 18 }]);
  });

  test('does not invent theme defaults when the authoritative snapshot omits theme fields', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      // SAFETY: this mock echoes back exactly the partial changes it received;
      // the tests below only read fields the changes actually contain.
      async (changes) => ({ ...changes } as SettingsPayload),
      async () => ({
        settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
        source: 'web',
      }),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      // SAFETY: dispatchSettingsSynced is the only emitter for this key and
      // always sends a CustomEvent<SettingsSyncedDetail>.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await syncDesktopSettings();
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    expect(synced.length).toBeGreaterThan(0);
    const bootstrapSync = synced.find((detail) => detail.bootstrap);
    expect(bootstrapSync).toBeTruthy();
    expect(bootstrapSync?.adoptTheme).toBe(true);
    expect(bootstrapSync?.settings.useSystemTheme).toBe(undefined);
    expect(bootstrapSync?.settings.lightThemeId).toBe(undefined);
    expect(bootstrapSync?.settings.darkThemeId).toBe(undefined);
  });

  test('marks settings save echoes as non-bootstrap syncs', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      // SAFETY: this mock echoes back exactly the partial changes it received;
      // the assertions below only read fields the changes actually contain.
      async (changes) => ({ ...changes } as SettingsPayload),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      // SAFETY: dispatchSettingsSynced is the only emitter for this key and
      // always sends a CustomEvent<SettingsSyncedDetail>.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await updateDesktopSettings({ themeVariant: 'dark' });
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    expect(synced.length).toBeGreaterThan(0);
    expect(synced.every((detail) => detail.bootstrap === false)).toBe(true);
    expect(synced.every((detail) => detail.adoptTheme === false)).toBe(true);
    expect(synced.every((detail) => detail.settings.themeVariant === 'dark')).toBe(true);
  });

  test('allows a bootstrap sync to preserve the current window theme', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      async (changes) => ({ ...changes } as SettingsPayload),
      async () => ({
        settings: { activeProjectId: 'project-a', themeVariant: 'dark' },
        source: 'web',
      }),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await syncDesktopSettings({ adoptTheme: false });
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    const broadcastSync = synced.find((detail) => detail.bootstrap && !detail.adoptTheme);
    expect(broadcastSync).toBeTruthy();
    expect(broadcastSync?.settings.activeProjectId).toBe('project-a');
    expect(broadcastSync?.settings.themeVariant).toBe('dark');
  });
});

describe('unload lifecycle flush (#2197)', () => {
  beforeEach(() => {
    getWindow();
    isolateRuntime();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
  });

  test('flushes a pending debounced settings save on pagehide without a double write', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    const update = updateDesktopSettings({ showDeletionDialog: false });
    expect(saveCalls).toEqual([]);

    getWindow().dispatchEvent(new Event('pagehide'));

    // The flush must hand the pending changes to the settings backend
    // synchronously inside the lifecycle listener — an unloading window has
    // no later turn for the debounce timer.
    expect(saveCalls).toEqual([{ showDeletionDialog: false }]);

    await update;
    await delay(300);
    // The canceled debounce timer must not replay the same write.
    expect(saveCalls).toHaveLength(1);
  });

  test('flushes a pending debounced settings save on beforeunload without a double write', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    const update = updateDesktopSettings({ gitChangesViewMode: 'tree' });
    expect(saveCalls).toEqual([]);

    getWindow().dispatchEvent(new Event('beforeunload'));

    expect(saveCalls).toEqual([{ gitChangesViewMode: 'tree' }]);

    await update;
    await delay(300);
    expect(saveCalls).toHaveLength(1);
  });

  test('persists a showDeletionDialog toggle followed by an immediate unload', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });
    startAppearanceAutoSave();

    try {
      useUIStore.getState().setShowDeletionDialog(false);
      getWindow().dispatchEvent(new Event('pagehide'));

      expect(saveCalls.some((changes) => changes.showDeletionDialog === false)).toBe(true);
    } finally {
      useUIStore.getState().setShowDeletionDialog(true);
      // Let the restore write drain so it cannot leak into other tests.
      await delay(300);
    }
  });

  test('persists a first model preference followed by an immediate unload', async () => {
    resetModelPrefsState();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      value: new EventTarget(), configurable: true, writable: true,
    });
    const stopModelPrefs = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      getWindow().dispatchEvent(new Event('pagehide'));
      // The exact user delta waits for its authoritative base read, then uses keepalive.
      await delay(0);
      expect(saveCalls).toEqual([{
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
      }]);
    } finally {
      stopModelPrefs();
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      await delay(300);
    }
  });

  test('sends the unload flush with keepalive so the browser cannot cancel it', async () => {
    // No runtime settings API: the write has to take the HTTP branch, which is
    // the one the browser cancels on unload without `keepalive`.
    registerRuntimeAPIs(null);
    const inits: RequestInit[] = [];
    const previousFetch = globalThis.fetch;
    // SAFETY: the mock receives only the (input, init) pair production code
    // passes and always resolves to a Response; the assertion supplies the
    // overload signatures a plain arrow function cannot declare.
    globalThis.fetch = (async (_input, init) => {
      inits.push(init ?? {});
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const update = updateDesktopSettings({ gitChangesViewMode: 'flat' });
      getWindow().dispatchEvent(new Event('pagehide'));
      await update;
      await delay(50);

      expect(inits).toHaveLength(1);
      expect(inits[0].method).toBe('PUT');
      expect(inits[0].keepalive).toBe(true);

      // The ordinary debounced write stays a plain fetch.
      inits.length = 0;
      await updateDesktopSettings({ gitChangesViewMode: 'tree' });
      await delay(300);
      expect(inits).toHaveLength(1);
      expect(inits[0].keepalive).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('ignores lifecycle events when no settings write is pending', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    getWindow().dispatchEvent(new Event('pagehide'));
    getWindow().dispatchEvent(new Event('beforeunload'));
    await delay(50);

    expect(saveCalls).toEqual([]);
  });
});

describe('startup writes before the first authoritative load (smarty-code#117)', () => {
  const shared = {
    homeDirectory: '/home/owner',
    lastDirectory: '/home/owner/work/net',
    themeId: 'owner-dark',
    themeVariant: 'dark' as const,
    useSystemTheme: false,
    draftStartersCraftGoalAdded: true,
    draftStartersScheduleTaskAdded: true,
  };
  // What a fresh browser's first render publishes before settings arrive.
  const startupDefaults = {
    homeDirectory: '/home/owner',
    lastDirectory: '/home/owner',
    themeId: 'default-light',
    themeVariant: 'light' as const,
    useSystemTheme: true,
  };
  const ownerKeys = Object.keys(startupDefaults);

  beforeEach(() => {
    getWindow();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
  });

  test('a fresh browser does not replace existing shared settings with its startup defaults', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({ settings: { ...shared }, source: 'web' }));

    deferSettingsWritesUntilLoaded();
    const startup = updateDesktopSettings({ ...startupDefaults });
    await delay(300);
    expect(saveCalls).toEqual([]);

    await syncDesktopSettings();
    await startup;
    await delay(300);

    expect(saveCalls.filter((changes) => ownerKeys.some((key) => key in changes))).toEqual([]);
  });

  test('keeps startup values the server lacks and saves later choices normally', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({ settings: { ...shared }, source: 'web' }));

    deferSettingsWritesUntilLoaded();
    const startup = updateDesktopSettings({ lastDirectory: '/home/owner', gitChangesViewMode: 'tree' });
    await syncDesktopSettings();
    await startup;
    await delay(300);
    expect(saveCalls.some((changes) => changes.gitChangesViewMode === 'tree' && !('lastDirectory' in changes))).toBe(true);

    saveCalls.length = 0;
    await updateDesktopSettings({ lastDirectory: '/home/owner/work/code' });
    expect(saveCalls).toEqual([{ lastDirectory: '/home/owner/work/code' }]);
  });

  test('drops startup defaults when the page unloads before settings load', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({ settings: { ...shared }, source: 'web' }));

    deferSettingsWritesUntilLoaded();
    const startup = updateDesktopSettings({ ...startupDefaults });
    getWindow().dispatchEvent(new Event('pagehide'));
    await startup;
    await delay(50);
    expect(saveCalls).toEqual([]);

    // Release the gate so it cannot leak into later tests.
    await syncDesktopSettings();
    await delay(300);
    expect(saveCalls.filter((changes) => ownerKeys.some((key) => key in changes))).toEqual([]);
  });
});
