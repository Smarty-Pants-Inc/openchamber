import { useUIStore } from '@/stores/useUIStore';
import { isApplyingServerSettings, updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { restoringModelPrefs } from '@/lib/modelPrefsRestore';
import { copyModelPrefs, mergeExplicitChange, serverFields } from '@/lib/modelPrefsShared';

type ModelRef = { providerID: string; modelID: string };
type ModelPrefsPayload = {
  favoriteModels: ModelRef[];
  hiddenModels: ModelRef[];
  collapsedModelProviders: string[];
  recentModels: ModelRef[];
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;
};

const refsEqual = (a: ModelRef[], b: ModelRef[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.providerID !== b[i]?.providerID) return false;
    if (a[i]?.modelID !== b[i]?.modelID) return false;
  }
  return true;
};

const stringsEqual = (a: string[], b: string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const recentEffortsEqual = (a: Record<string, string[]>, b: Record<string, string[]>): boolean => {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Array.isArray(b[key]) && stringsEqual(a[key], b[key]));
};

const snapshotModelPrefs = (): ModelPrefsPayload => {
  const state = useUIStore.getState();
  return {
    favoriteModels: state.favoriteModels,
    hiddenModels: state.hiddenModels,
    collapsedModelProviders: state.collapsedModelProviders,
    recentModels: state.recentModels,
    recentAgents: state.recentAgents,
    recentEfforts: state.recentEfforts,
  };
};

const modelPrefsEqual = (a: ModelPrefsPayload, b: ModelPrefsPayload): boolean => (
  refsEqual(a.favoriteModels, b.favoriteModels) &&
  refsEqual(a.hiddenModels, b.hiddenModels) &&
  stringsEqual(a.collapsedModelProviders, b.collapsedModelProviders) &&
  refsEqual(a.recentModels, b.recentModels) &&
  stringsEqual(a.recentAgents, b.recentAgents) &&
  recentEffortsEqual(a.recentEfforts, b.recentEfforts)
);

export const startModelPrefsAutoSave = () => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let timer: number | null = null;
  let scheduledRuntimeKey: string | null = null;
  // The shared copy as last known: the values in the store when saving starts, then each field the server applies and
  // each explicit change. A restore (or local rehydration) never enters it, so it never reaches the server (#126 F6).
  let shared: ModelPrefsPayload = copyModelPrefs(snapshotModelPrefs());
  // Only the fields explicit choices changed, taken when they were made; a restore within the debounce never rides along.
  let pending: Partial<ModelPrefsPayload> = {};

  const flush = () => {
    timer = null;
    const runtimeKey = scheduledRuntimeKey, payload = pending;
    scheduledRuntimeKey = null; pending = {};
    if (!runtimeKey || runtimeKey !== getRuntimeKey() || Object.keys(payload).length === 0) return;
    void updateDesktopSettings(payload).catch(() => {});
  };

  const schedule = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    scheduledRuntimeKey = getRuntimeKey();
    timer = window.setTimeout(flush, 1200);
  };

  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    scheduledRuntimeKey = null;
    pending = {};
  });

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    const next = {
      favoriteModels: state.favoriteModels,
      hiddenModels: state.hiddenModels,
      collapsedModelProviders: state.collapsedModelProviders,
      recentModels: state.recentModels,
      recentAgents: state.recentAgents,
      recentEfforts: state.recentEfforts,
    };
    const prev = {
      favoriteModels: prevState.favoriteModels,
      hiddenModels: prevState.hiddenModels,
      collapsedModelProviders: prevState.collapsedModelProviders,
      recentModels: prevState.recentModels,
      recentAgents: prevState.recentAgents,
      recentEfforts: prevState.recentEfforts,
    };
    if (modelPrefsEqual(next, prev)) return;
    // Values the server sent are its copy; they are not sent back.
    if (isApplyingServerSettings()) { shared = { ...shared, ...serverFields(prev, next) }; return; }
    // Local rehydration and session restores are not user choices; they stay local.
    if (useUIStore.persist?.hasHydrated?.() === false || restoringModelPrefs()) return;
    const changes = mergeExplicitChange(prev, next, shared);
    shared = { ...shared, ...changes };
    pending = { ...pending, ...changes };
    schedule();
  });

  return () => {
    unsubscribe();
    unsubscribeRuntime();
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};
