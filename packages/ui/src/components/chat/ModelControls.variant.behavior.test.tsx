import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import type { OrdinaryModelChange, OrdinaryModelState } from '@/lib/opencode/ordinaryModel';

/**
 * Restoring a session must not invent an effort choice.
 *
 * The selection store keeps three states for a session's effort: an effort
 * name, `null` for an explicit "Default", and `undefined` for no choice at all.
 * Only the picker may write `null`. When a restore path writes it instead, the
 * session latches onto "Default" — `null` outranks the agent and settings
 * defaults by design — and the concrete effort the session's own history
 * carries can never come back. These tests pin who writes what.
 */

type VariantChoice = string | null | undefined;

type UserModelChoice = {
  id: string;
  agent?: string;
  providerID: string;
  modelID: string;
  variant?: string;
};

const PROVIDER_ID = 'openai';
const MODEL_ID = 'gpt-5.5';
const AGENT = 'build';
const SESSION_ID = 'ses_restore';

const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  providerID: PROVIDER_ID,
  variants: { low: {}, high: {} },
};
const provider = { id: PROVIDER_ID, name: PROVIDER_ID, models: [model] };
const agent = { name: AGENT, mode: 'primary' as const };

let latestUserChoice: UserModelChoice | null = null;
let fixtureHistory: unknown[] = [];
let forcePreserveManualOverride: boolean | null = null;
/** Directories whose provider catalog the ordinary picker asked to re-read. */
const providerLoads: Array<string | null> = [];
/** Ordinary model switches sent to the gateway, and the outcome each one gets. */
const modelChanges: Array<{ id: string; directory: string; change: OrdinaryModelChange }> = [];
const unchanged: OrdinaryModelState = { generation: 'generation-B', sequence: 1, model: null, thinkingLevel: null };
let modelChangeResult: () => Promise<OrdinaryModelState> = async () => unchanged;
type HistoryTarget = { directory: string; sessionID: string };
const viewRefreshes: HistoryTarget[] = [];
const toastErrors: string[] = [];

/** Every effort written for the session, in order, including `undefined`. */
const variantWrites: VariantChoice[] = [];
/** Every `(override, inherited)` pair pushed into the config store. */
const overrideWrites: Array<{ override: VariantChoice; inherited: string | undefined }> = [];

type ConfigState = {
  providers: typeof provider[];
  agents: typeof agent[];
  modelsMetadata: Record<string, never>;
  currentProviderId: string;
  currentModelId: string;
  currentVariant: string | undefined;
  currentVariantSelection: { override: VariantChoice; inherited: string | undefined };
  currentAgentName: string | undefined;
  settingsDefaultVariant: string | undefined;
  settingsDefaultAgent: string | undefined;
  selectionSource: 'auto' | 'manual';
  setProvider: (providerId: string) => void;
  setSelectedProvider: (providerId: string) => void;
  setModel: (modelId: string) => void;
  setAgent: (agentName: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  setCurrentVariantOverride: (override: VariantChoice, inherited: string | undefined) => void;
  getCurrentProvider: () => typeof provider;
  getCurrentAgent: () => typeof agent;
  getVisibleAgents: () => typeof agent[];
  getCurrentModelVariants: () => string[];
  getModelMetadata: () => undefined;
  loadProviders: (options?: { directory?: string | null }) => Promise<void>;
};

const useConfigStore = create<ConfigState>((set) => ({
  providers: [provider],
  agents: [agent],
  modelsMetadata: {},
  currentProviderId: PROVIDER_ID,
  currentModelId: MODEL_ID,
  currentVariant: undefined,
  currentVariantSelection: { override: undefined, inherited: undefined },
  currentAgentName: AGENT,
  settingsDefaultVariant: undefined,
  settingsDefaultAgent: undefined,
  selectionSource: 'auto',
  setProvider: (providerId) => set({ currentProviderId: providerId }),
  setSelectedProvider: () => undefined,
  setModel: (modelId) => set({ currentModelId: modelId }),
  setAgent: (agentName) => set({ currentAgentName: agentName }),
  // Mirrors the real store, including its no-op guard: without that guard an
  // unchanged write returns a fresh state object every render and the
  // component's variant effects never settle.
  setCurrentVariant: (variant) => {
    useConfigStore.getState().setCurrentVariantOverride(undefined, variant);
  },
  setCurrentVariantOverride: (override, inherited) => {
    set((state) => {
      const currentVariant = override === null ? undefined : override ?? inherited;
      if (
        state.currentVariant === currentVariant
        && state.currentVariantSelection.override === override
        && state.currentVariantSelection.inherited === inherited
      ) {
        return state;
      }
      overrideWrites.push({ override, inherited });
      return { currentVariant, currentVariantSelection: { override, inherited } };
    });
  },
  getCurrentProvider: () => provider,
  getCurrentAgent: () => agent,
  getVisibleAgents: () => [agent],
  getCurrentModelVariants: () => Object.keys(model.variants),
  getModelMetadata: () => undefined,
  loadProviders: async (options) => { providerLoads.push(options?.directory ?? null); },
}));

type SelectionState = {
  savedVariant: VariantChoice;
  sessionAgentSelections: Map<string, string>;
  getSessionModelSelection: () => { providerId: string; modelId: string } | null;
  getSessionAgentSelection: () => string | null;
  getAgentModelForSession: () => { providerId: string; modelId: string } | null;
  getAgentModelVariantForSession: () => VariantChoice;
  saveSessionModelSelection: () => void;
  saveSessionAgentSelection: () => void;
  saveAgentModelForSession: () => void;
  saveAgentModelVariantForSession: (
    sessionId: string,
    agentName: string,
    providerId: string,
    modelId: string,
    variant: VariantChoice,
  ) => void;
};

const useSelectionStore = create<SelectionState>((set, get) => ({
  savedVariant: undefined,
  sessionAgentSelections: new Map([[SESSION_ID, AGENT]]),
  getSessionModelSelection: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getSessionAgentSelection: () => AGENT,
  getAgentModelForSession: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getAgentModelVariantForSession: () => get().savedVariant,
  saveSessionModelSelection: () => undefined,
  saveSessionAgentSelection: () => undefined,
  saveAgentModelForSession: () => undefined,
  saveAgentModelVariantForSession: (_sessionId, _agentName, _providerId, _modelId, variant) => {
    variantWrites.push(variant);
    set({ savedVariant: variant });
  },
}));

const useSessionUIStore = create(() => ({
  currentSessionId: SESSION_ID,
  getDirectoryForSession: () => '/workspace/project',
}));

const useNativeSessions = create<{ sessions: Record<string, Session> }>(() => ({ sessions: {} }));

const useUIStore = create(() => ({
  isMobile: false,
  isModelSelectorOpen: false,
  hiddenModels: [],
  providerOrder: [],
  shortcutOverrides: {},
  isFavoriteModel: () => false,
  toggleFavoriteModel: () => undefined,
  reorderFavoriteModel: () => undefined,
  setProviderOrder: () => undefined,
  setModelSelectorOpen: () => undefined,
  setSettingsDialogOpen: () => undefined,
  setSettingsPage: () => undefined,
  addRecentAgent: () => undefined,
  addRecentModel: () => undefined,
  addRecentEffort: () => undefined,
}));

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

// Captured by value before the module is replaced: reading it back off the
// namespace afterwards would resolve to the replacement and recurse.
const { shouldPreserveManualModelOverride: realShouldPreserveManualModelOverride } =
  await import('@/lib/messages/userModelChoice');

mock.module('@/lib/messages/userModelChoice', () => ({
  findLatestUserModelChoice: () => latestUserChoice,
  // The real guard, unless a test opts out: whether it fires decides which
  // restore branch runs, and the branch that erased a recorded Default is the
  // one it declines to protect.
  shouldPreserveManualModelOverride: (args: Parameters<typeof realShouldPreserveManualModelOverride>[0]) => (
    forcePreserveManualOverride ?? realShouldPreserveManualModelOverride(args)
  ),
}));

mock.module('@/stores/useConfigStore', () => ({ useConfigStore }));
mock.module('@/sync/selection-store', () => ({ useSelectionStore }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore }));
mock.module('@/stores/useUIStore', () => ({ useUIStore }));
mock.module('@/stores/contextStore', () => ({
  useContextStore: <T,>(selector: (state: { hasHydrated: boolean }) => T): T => selector({ hasHydrated: true }),
}));

mock.module('@/sync/sync-context', () => ({
  useSession: (id?: string | null, directory?: string) => useNativeSessions(state => {
    const session = id ? state.sessions[id] : undefined;
    return session?.directory === directory ? session : undefined;
  }),
  useSessionMessages: () => fixtureHistory,
  useSessionRenderable: () => true,
}));
mock.module('@/sync/use-sync', () => ({ useSync: () => ({ sessions: [] }) }));
mock.module('@/sync/sync-refs', () => ({ getSyncParts: () => [] }));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuItem: passthrough,
  DropdownMenuLabel: passthrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: passthrough,
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: passthrough }));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/model-picker/ModelPickerList', () => ({ ModelPickerList: () => null }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useIsVSCodeRuntime: () => false }));
mock.module('@/hooks/useModelLists', () => ({ useModelLists: () => ({ favoriteModels: [], recentModels: [] }) }));
mock.module('@/hooks/useIsTextTruncated', () => ({ useIsTextTruncated: () => false }));
mock.module('@/hooks/useOpenCodeReadiness', () => ({
  useOpenCodeReadiness: () => ({ isReady: true, isUnavailable: false }),
}));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isTouch: false }) }));
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => false }));
mock.module('@/lib/startupTrace', () => ({ markStartupTrace: () => undefined }));

// A minimal select: items are buttons that report their value, so tests can choose one.
const SelectChange = React.createContext<((value: string) => void) | undefined>(undefined);
mock.module('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, disabled }: React.PropsWithChildren<{ onValueChange?: (value: string) => void; disabled?: boolean }>) => (
    <SelectChange.Provider value={disabled ? undefined : onValueChange}><div data-select="">{children}</div></SelectChange.Provider>
  ),
  SelectTrigger: ({ children, ...props }: React.PropsWithChildren<{ 'aria-label'?: string }>) => (
    <span data-trigger={props['aria-label']}>{children}</span>
  ),
  SelectContent: passthrough,
  SelectItem: function SelectItem({ value, children }: React.PropsWithChildren<{ value: string }>) {
    const change = React.useContext(SelectChange);
    return <button type="button" data-value={value} onClick={() => change?.(value)}>{children}</button>;
  },
}));
mock.module('@/components/ui', () => ({ toast: { error: (message: string) => { toastErrors.push(message); } } }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  setOrdinaryModel: async (id: string, directory: string, change: OrdinaryModelChange) => {
    modelChanges.push({ id, directory, change });
    return modelChangeResult();
  },
} }));
mock.module('@/sync/session-message-loader', () => ({
  getImperativeSessionMessageLoader: () => ({ refreshOrdinaryView: async (target: HistoryTarget) => { viewRefreshes.push(target); } }),
}));

mock.module('@/sync/native-draft-creation', () => ({ applyNativeDraftModel: () => undefined }));

const { ModelControls } = await import('./ModelControls');
const { I18nProvider } = await import('@/lib/i18n');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLIFrameElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const frameTimers = new Map<number, ReturnType<Window['setTimeout']>>();
let nextFrameHandle = 1;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    // The component focuses the composer through rAF on several paths.
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = nextFrameHandle++;
      frameTimers.set(handle, happyWindow.setTimeout(() => {
        frameTimers.delete(handle);
        callback(0);
      }, 0));
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      const timer = frameTimers.get(handle);
      if (timer === undefined) return;
      frameTimers.delete(handle);
      happyWindow.clearTimeout(timer);
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const renderModelControls = async () => {
  const dom = installDom();
  const root = createRoot(dom.container);
  await act(async () => root.render(
    <I18nProvider>
      <ModelControls />
    </I18nProvider>,
  ));
  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

beforeEach(() => {
  fixtureHistory = [];
  useNativeSessions.setState({ sessions: {} });
  useSessionUIStore.setState({ currentSessionId: SESSION_ID });
  useConfigStore.setState({ providers: [provider] });
});

describe('ModelControls effort restore', () => {
  beforeEach(() => {
    variantWrites.length = 0;
    overrideWrites.length = 0;
    latestUserChoice = null;
    forcePreserveManualOverride = null;
    useSelectionStore.setState({ savedVariant: undefined });
    useConfigStore.setState({
      currentProviderId: PROVIDER_ID,
      currentModelId: MODEL_ID,
      currentAgentName: AGENT,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
    });
  });

  test('restores the concrete effort the session history carries', async () => {
    latestUserChoice = { id: 'msg-1', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'low' };

    const { cleanup } = await renderModelControls();
    try {
      expect(variantWrites).toContain('low');
      expect(variantWrites).not.toContain(null);
      expect(useSelectionStore.getState().savedVariant).toBe('low');
      expect(useConfigStore.getState().currentVariantSelection.override).toBe('low');
    } finally {
      await cleanup();
    }
  });

  test('history without an effort records no choice instead of an explicit Default', async () => {
    latestUserChoice = { id: 'msg-2', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID };

    const { cleanup } = await renderModelControls();
    try {
      expect(variantWrites).not.toContain(null);
      expect(useSelectionStore.getState().savedVariant).toBe(undefined);
      expect(useConfigStore.getState().currentVariantSelection.override).toBe(undefined);
    } finally {
      await cleanup();
    }
  });

  test('the echo of a Default send does not erase the recorded Default', async () => {
    // The reported repro. The send under "Default" carried no effort, so the
    // message it echoes back carries none either, and its model matches the one
    // the send saved — which is exactly when the manual-override guard declines
    // to protect the selection and the history branch runs.
    latestUserChoice = { id: 'msg-echo', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID };
    useSelectionStore.setState({ savedVariant: null });
    useConfigStore.setState({
      selectionSource: 'manual',
      settingsDefaultVariant: 'low',
      currentVariantSelection: { override: null, inherited: 'low' },
    });

    const { cleanup } = await renderModelControls();
    try {
      expect(useSelectionStore.getState().savedVariant).toBeNull();
      expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
      expect(useConfigStore.getState().currentVariant).toBe(undefined);
    } finally {
      await cleanup();
    }
  });

  test('a preserved manual override keeps a recorded explicit Default', async () => {
    latestUserChoice = { id: 'msg-3', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'high' };
    forcePreserveManualOverride = true;
    useSelectionStore.setState({ savedVariant: null });
    useConfigStore.setState({ selectionSource: 'manual' });

    const { cleanup } = await renderModelControls();
    try {
      expect(useSelectionStore.getState().savedVariant).toBeNull();
      expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

const nativeSession = (id = 'B', modelID = 'live-b', sequence = 1): Session & { ordinary: OrdinaryModelState } => ({
  id, slug: id, directory: '/workspace/project', projectID: 'fixture', title: id, version: '1',
  time: { created: 1, updated: 1 },
  ordinary: {
    generation: `generation-${id}`, sequence, thinkingLevel: 'high',
    model: { providerID: `fixture-${id.toLowerCase()}`, modelID, name: modelID },
  },
});

describe('ordinary selected-session controls', () => {
  beforeEach(() => {
    variantWrites.length = 0;
    overrideWrites.length = 0;
    latestUserChoice = null;
    useSessionUIStore.setState({ currentSessionId: 'B' });
    useNativeSessions.setState({ sessions: { B: nativeSession() } });
    useConfigStore.setState({ currentProviderId: PROVIDER_ID, currentModelId: MODEL_ID });
    providerLoads.length = 0; modelChanges.length = 0; viewRefreshes.length = 0; toastErrors.length = 0;
    modelChangeResult = async () => unchanged;
  });

  for (const history of ['empty', 'old-assistant', 'old-user', 'old-user-with-catalog-union']) {
    test(`live B wins over ${history} and first-A catalog/defaults`, async () => {
      if (history === 'old-assistant') fixtureHistory = [{ role: 'assistant', id: 'old-b', providerID: 'fixture-b', modelID: 'old-b' }];
      if (history.startsWith('old-user')) latestUserChoice = {
        id: 'old-b', providerID: 'fixture-b', modelID: 'old-b', variant: 'low', agent: AGENT,
      };
      if (history.endsWith('union')) useConfigStore.setState({ providers: [provider, {
        id: 'fixture-b', name: 'fixture-b', models: [{ ...model, id: 'old-b', providerID: 'fixture-b' }],
      }] });
      const { dom, cleanup } = await renderModelControls();
      try {
        expect(dom.container.textContent).toContain('fixture-b');
        expect(dom.container.querySelector('.model-controls__model-label')?.textContent).toBe('live-b');
        expect(dom.container.querySelector('.model-controls__variant-label')?.textContent).toBe('High');
        expect(dom.container.querySelector('button')).toBeNull();
        expect(useConfigStore.getState().currentModelId).toBe(MODEL_ID);
        expect(variantWrites).toEqual([]);
      } finally { await cleanup(); }
    });
  }

  test('model/effort-only updates render without messages and delayed A cannot replace selected B', async () => {
    const { dom, cleanup } = await renderModelControls();
    try {
      const next = nativeSession('B', 'new-live-b', 2);
      next.ordinary.thinkingLevel = 'low';
      await act(async () => useNativeSessions.setState({ sessions: { B: next, A: nativeSession('A', 'live-a') } }));
      expect(dom.container.querySelector('.model-controls__model-label')?.textContent).toBe('new-live-b');
      expect(dom.container.querySelector('.model-controls__variant-label')?.textContent).toBe('Low');
      await act(async () => useSessionUIStore.setState({ currentSessionId: 'A' }));
      expect(dom.container.querySelector('.model-controls__model-label')?.textContent).toBe('live-a');
      await act(async () => useSessionUIStore.setState({ currentSessionId: 'B' }));
      await act(async () => useNativeSessions.setState({ sessions: { B: next, A: nativeSession('A', 'delayed-a', 3) } }));
      expect(dom.container.querySelector('.model-controls__model-label')?.textContent).toBe('new-live-b');
      expect(dom.container.textContent).not.toContain('delayed-a');
      expect(variantWrites).toEqual([]);
    } finally { await cleanup(); }
  });

  test('marker-only native summary stays unavailable instead of mounting stock defaults', async () => {
    const marker: Session & { nativeRuntime: 'ordinary'; ordinary?: OrdinaryModelState } = {
      ...nativeSession(), nativeRuntime: 'ordinary',
    };
    delete marker.ordinary;
    useNativeSessions.setState({ sessions: { B: marker } });
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.textContent).toContain('Unavailable');
      expect(dom.container.querySelector('.model-controls__model-label')).toBeNull();
      expect(dom.container.querySelector('button')).toBeNull();
      expect(variantWrites).toEqual([]);
    } finally { await cleanup(); }
  });

  const liveCatalog = () => useConfigStore.setState({ providers: [provider, {
    id: 'fixture-b', name: 'fixture-b', models: [
      { ...model, id: 'live-b', name: 'live-b', providerID: 'fixture-b' },
      { ...model, id: 'other-b', name: 'other-b', providerID: 'fixture-b' },
    ],
  }] });
  const choose = async (container: HTMLElement, value: string) => {
    const option = [...container.querySelectorAll('button')].find(button => button.getAttribute('data-value') === value);
    expect(option).toBeDefined();
    await act(async () => { option!.click(); });
  };

  test('a catalog model switches the native session by its observed generation, then re-reads the view', async () => {
    liveCatalog();
    const { dom, cleanup } = await renderModelControls();
    try {
      await choose(dom.container, JSON.stringify(['fixture-b', 'other-b']));
      await choose(dom.container, 'low');
      expect(modelChanges).toEqual([
        { id: 'B', directory: '/workspace/project', change: { generation: 'generation-B',
          model: { providerID: 'fixture-b', modelID: 'other-b' } } },
        { id: 'B', directory: '/workspace/project', change: { generation: 'generation-B',
          model: { providerID: 'fixture-b', modelID: 'live-b' }, thinkingLevel: 'low' } },
      ]);
      expect(viewRefreshes).toEqual([{ directory: '/workspace/project', sessionID: 'B' }, { directory: '/workspace/project', sessionID: 'B' }]);
      // Only the native session's own report changes what is shown.
      expect(dom.container.querySelector('.model-controls__model-label')?.textContent).toBe('live-b');
      expect(dom.container.querySelector('.model-controls__variant-label')?.textContent).toBe('High');
      expect(variantWrites).toEqual([]);
      expect(useConfigStore.getState().currentModelId).toBe(MODEL_ID);
    } finally { await cleanup(); }
  });

  test('a refused switch reports the gateway reason and keeps the accepted view', async () => {
    liveCatalog();
    modelChangeResult = async () => { throw new Error('Native model change refused; nothing was applied'); };
    const { dom, cleanup } = await renderModelControls();
    try {
      await choose(dom.container, 'low');
      expect(toastErrors).toEqual(['Native model change refused; nothing was applied']);
      expect(viewRefreshes).toEqual([]);
    } finally { await cleanup(); }
  });

  test('a live model outside the loaded catalog stays read-only and re-reads the project catalog', async () => {
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.querySelector('button')).toBeNull();
      expect(providerLoads).toEqual(['/workspace/project']);
    } finally { await cleanup(); }
  });

  test('explicit unavailable native state cannot display a catalog or historical fallback', async () => {
    const unavailable = nativeSession();
    unavailable.ordinary.model = null;
    unavailable.ordinary.thinkingLevel = null;
    useNativeSessions.setState({ sessions: { B: unavailable } });
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.querySelector('.model-controls__model-label')).toBeNull();
      expect(dom.container.querySelector('button')).toBeNull();
      expect(dom.container.textContent).not.toContain(MODEL_ID);
      expect(variantWrites).toEqual([]);
    } finally { await cleanup(); }
  });
});
