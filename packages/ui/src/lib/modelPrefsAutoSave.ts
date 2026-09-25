import { useUIStore } from '@/stores/useUIStore';
import { isApplyingServerSettings } from '@/lib/persistence';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SettingsConflictError } from '@/lib/projectSettingsMerge';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { restoringModelPrefs } from '@/lib/modelPrefsRestore';
import { mergeExplicitChange, type ModelPrefs } from '@/lib/modelPrefsShared';

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

const modelPrefsEqual = (a: ModelPrefsPayload, b: ModelPrefsPayload): boolean => (
  refsEqual(a.favoriteModels, b.favoriteModels) &&
  refsEqual(a.hiddenModels, b.hiddenModels) &&
  stringsEqual(a.collapsedModelProviders, b.collapsedModelProviders) &&
  refsEqual(a.recentModels, b.recentModels) &&
  stringsEqual(a.recentAgents, b.recentAgents) &&
  recentEffortsEqual(a.recentEfforts, b.recentEfforts)
);

/** The shared settings as the server holds them now, and their revision. */
export type ModelPrefsServer = {
  read(): Promise<{ prefs: ModelPrefs; etag: string | null }>;
  /** Writes only these keys if the settings are still at `etag`; 'conflict' when they changed meanwhile. */
  write(changes: Partial<ModelPrefs>, etag: string | null): Promise<'ok' | 'conflict'>;
};

const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
/** The runtime's settings API: load with its revision, conditional save (a rejected condition throws a conflict). */
const runtimeServer: ModelPrefsServer = {
  async read() {
    const api = getRegisteredRuntimeAPIs()?.settings;
    if (!api) throw new Error('No settings API');
    const { settings, revision } = await api.load();
    const body = settings as Record<string, unknown>;
    const efforts = body.recentEfforts && typeof body.recentEfforts === 'object' ? body.recentEfforts as Record<string, string[]> : {};
    return { etag: revision ?? null, prefs: { favoriteModels: list(body.favoriteModels), hiddenModels: list(body.hiddenModels),
      collapsedModelProviders: list(body.collapsedModelProviders), recentModels: list(body.recentModels),
      recentAgents: list(body.recentAgents), recentEfforts: efforts } };
  },
  async write(changes, etag) {
    const api = getRegisteredRuntimeAPIs()?.settings;
    if (!api) throw new Error('No settings API');
    try { await api.save(changes, etag ? { ifMatch: etag } : undefined); return 'ok'; }
    catch (error) { if (error instanceof SettingsConflictError) return 'conflict'; throw error; }
  },
};

/**
 * smarty-code#126 F6 (the #117 rule): the shared model preferences change only by the exact change of an explicit
 * user action. Each explicit change is a read-modify-write against the server: read the current settings and their
 * revision, apply exactly that change, and write only the keys it touched with If-Match; on a conflict, once more
 * from a fresh read. Session restores (withoutSharingModelPrefs), local rehydration and server-applied values never
 * write. There is no local copy of the shared settings to drift.
 */
export const startModelPrefsAutoSave = (server: ModelPrefsServer = runtimeServer) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let timer: number | null = null;
  let scheduledRuntimeKey: string | null = null;
  // Explicit changes waiting for the debounce, each as the user made it.
  let pending: Array<{ prev: ModelPrefs; next: ModelPrefs }> = [];

  const apply = async (changes: Array<{ prev: ModelPrefs; next: ModelPrefs }>, runtimeKey: string) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { prefs, etag } = await server.read();
      if (runtimeKey !== getRuntimeKey()) return;
      let current = prefs, touched: Partial<ModelPrefs> = {};
      for (const change of changes) {
        const delta = mergeExplicitChange(change.prev, change.next, current);
        current = { ...current, ...delta }; touched = { ...touched, ...delta };
      }
      if (Object.keys(touched).length === 0) return;
      if (await server.write(touched, etag) === 'ok') return;
    }
  };

  const flush = () => {
    timer = null;
    const runtimeKey = scheduledRuntimeKey, changes = pending;
    scheduledRuntimeKey = null; pending = [];
    if (!runtimeKey || runtimeKey !== getRuntimeKey() || changes.length === 0) return;
    void apply(changes, runtimeKey).catch(() => {});
  };

  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    scheduledRuntimeKey = null;
    pending = [];
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
    if (modelPrefsEqual(next, prev) || isApplyingServerSettings()) return;
    // Local rehydration and session restores are not user choices; they never write.
    if (useUIStore.persist?.hasHydrated?.() === false || restoringModelPrefs()) return;
    pending.push({ prev, next });
    if (timer !== null) window.clearTimeout(timer);
    scheduledRuntimeKey = getRuntimeKey();
    timer = window.setTimeout(flush, 1200);
  });

  return () => {
    unsubscribe();
    unsubscribeRuntime();
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};
