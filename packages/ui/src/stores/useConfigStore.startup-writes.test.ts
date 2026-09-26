import { expect, mock, test } from 'bun:test';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';
type TestAgent = { name: string; mode?: string; hidden?: boolean; model?: { providerID?: string; modelID?: string }; variant?: string };

let storage = new Map<string, string>();
let liveProviderId = 'live';
const liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: Record<string, Record<string, unknown>> | undefined;
let liveAgents: TestAgent[] = [];
const listAgentsImpl: ((directory?: string | null) => Promise<TestAgent[]>) | null = null;
const withDirectoryCalls: Array<string | null> = [];
let currentFetchDirectory: string | null = DIRECTORY;
let selectedDirectory = DIRECTORY;
const configScopes: Array<string | null | undefined> = [];
const managedSelections: string[] = [];
const rememberedSelections: string[] = [];
const managedCatalogAdmitted = false;
const managedProjects: { id: string; path: string; label: string }[] = [];
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
}) as Storage;

const provider = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: [
    {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      ...(variants ? { variants } : {}),
    },
  ],
});

const providerResponse = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: {
    [modelId]: {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      ...(variants ? { variants } : {}),
    },
  },
});

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  getSafeSessionStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => {
    const testStorage = makeStorage();
    return {
      getItem: (name: string) => {
        const value = testStorage.getItem(name);
        return value === null ? null : JSON.parse(value);
      },
      setItem: (name: string, value: unknown) => {
        testStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name: string) => {
        testStorage.removeItem(name);
      },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  visibleProjects: <T,>(state: { projects: T[]; managedProjects: T[]; managedCatalogAdmitted: boolean }) =>
    state.managedCatalogAdmitted ? state.managedProjects : state.projects,
  useProjectsStore: {
    getState: () => ({
      activeProjectId: managedCatalogAdmitted ? managedProjects[0]?.id ?? null : 'project',
      managedCatalogAdmitted,
      managedProjects,
      setActiveProject: (id: string, options?: { remember?: boolean }) => {
        managedSelections.push(id); if (options?.remember !== false) rememberedSelections.push(id);
        selectedDirectory = managedProjects.find(project => project.id === id)!.path;
      },
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => selectedDirectory),
    checkHealth: mock(async () => true),
    withDirectory: mock(async (directory: string | null, callback: () => Promise<unknown>) => {
      withDirectoryCalls.push(directory);
      const previous = currentFetchDirectory;
      currentFetchDirectory = directory;
      try {
        return await callback();
      } finally {
        currentFetchDirectory = previous;
      }
    }),
    getProviders: mock(async () => {
      const id = liveProviderIdsByDirectory.get(currentFetchDirectory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    getProvidersForConfig: mock(async (directory?: string | null) => {
      configScopes.push(directory);
      const id = liveProviderIdsByDirectory.get(directory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    listAgents: mock(async (directory?: string | null) => {
      configScopes.push(directory);
      const impl = listAgentsImpl as ((directory?: string | null) => Promise<TestAgent[]>) | null;
      return impl ? impl(directory) : liveAgents;
    }),
    getConfig: mock(async () => {
      return {};
    }),
    clearConfigCache: mock(() => undefined),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

// The shared settings this load reads (GET /api/config/settings), and every shared-settings write it makes.
let sharedSettings: Record<string, unknown> = {};
const settingsWrites: unknown[] = [];
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify(sharedSettings), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async (changes: unknown) => { settingsWrites.push(changes); }),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock((listener: typeof configListener) => {
    configListener = listener;
    return () => {
      if (configListener === listener) {
        configListener = null;
      }
    };
  }),
}));

const { useConfigStore } = await import('./useConfigStore');
const { setSyncRefs } = await import('@/sync/sync-refs');

// Run in its own process (CI's isolated runner): the module mocks above are this file's.
// smarty-code#117 (code-demo's pre-check): loadAgents wrote shared settings with no user action. The Zen fallback wrote
// the model it picked for git generation (a random zen model when the stored one was missing) and cleared the git model
// selection; the invalid-defaults cleanup erased a stored default model, variant or agent this load could not use.
// Both now apply in memory only: a first load in a fresh profile, and in a reopened browser, writes nothing.
for (const reopened of [false, true]) test(`${reopened ? 'a reopened browser' : 'a fresh profile'}: loading agents writes no shared settings`, async () => {
  storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  settingsWrites.length = 0;
  // A zen provider whose only model is not the stored one, and stored defaults this project does not have.
  liveProviderId = 'zen';
  liveAgents = [{ name: 'build', mode: 'primary' }];
  sharedSettings = { zenModel: 'retired-zen-model', gitProviderId: 'anthropic', gitModelId: 'claude',
    defaultModel: 'gone/model', defaultVariant: 'max', defaultAgent: 'ghost' };
  setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
  if (reopened) {
    // This browser's own earlier state: a cached config snapshot for the project, from a previous session.
    storage.set(STORAGE_KEY, JSON.stringify({ state: { activeDirectoryKey: DIRECTORY, settingsZenModel: 'zen-model',
      directoryScoped: { [DIRECTORY]: { providers: [provider('zen')], agents: [{ name: 'build', mode: 'primary' }],
        currentProviderId: 'zen', currentModelId: 'zen-model', currentAgentName: 'build', selectedProviderId: 'zen',
        agentModelSelections: {}, defaultProviders: { default: 'zen' } } } }, version: 0 }));
    await useConfigStore.persist.rehydrate();
  }
  useConfigStore.setState({ activeDirectoryKey: DIRECTORY, isConnected: true });
  await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
  await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settingsWrites).toEqual([]);
  const state = useConfigStore.getState();
  expect(state.settingsZenModel).toBe('zen-model'); // The fallback still applies, in memory.
  expect(state.settingsDefaultModel).toBeUndefined(); // The unusable defaults are ignored, in memory.
  expect(state.settingsDefaultAgent).toBeUndefined();
});
