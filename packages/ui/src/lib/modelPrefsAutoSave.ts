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
  /** Writes only these keys if the settings are still at `etag`; 'conflict' when they changed meanwhile.
   * `keepalive` lets the request outlive the page (unload flush). */
  write(changes: Partial<ModelPrefs>, etag: string | null, options?: { keepalive?: boolean }): Promise<'ok' | 'conflict'>;
};

/** A stored list, or none yet; anything else is not an authoritative read (OC#194 review). */
const list = <T>(body: Record<string, unknown>, field: string): T[] => {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Settings ${field} is not a list; nothing is written`);
  return value as T[];
};
/**
 * The runtime's settings API: load with its revision, conditional save (a rejected condition throws a conflict).
 * A read that failed (VS Code's defaults fallback) or has an invalid shape is never a base: the save is abandoned,
 * so existing preferences are never replaced by defaults. ponytail: VS Code's bridge has no revision, so its write is
 * unconditional after a fresh authoritative read; the serialized queue keeps this page's own writes in order.
 */
const runtimeServer: ModelPrefsServer = {
  async read() {
    const api = getRegisteredRuntimeAPIs()?.settings;
    if (!api) throw new Error('No settings API');
    const result = await api.load();
    if (result.fallback || !result.settings || typeof result.settings !== 'object') {
      throw new Error('The settings could not be read; nothing is written');
    }
    const body = result.settings as Record<string, unknown>;
    const efforts = body.recentEfforts;
    if (efforts !== undefined && (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts))) {
      throw new Error('Settings recentEfforts is not a map; nothing is written');
    }
    return { etag: result.revision ?? null, prefs: { favoriteModels: list(body, 'favoriteModels'), hiddenModels: list(body, 'hiddenModels'),
      collapsedModelProviders: list(body, 'collapsedModelProviders'), recentModels: list(body, 'recentModels'),
      recentAgents: list(body, 'recentAgents'), recentEfforts: (efforts ?? {}) as Record<string, string[]> } };
  },
  async write(changes, etag, options) {
    const api = getRegisteredRuntimeAPIs()?.settings;
    if (!api) throw new Error('No settings API');
    try { await api.save(changes, { ...(etag ? { ifMatch: etag } : {}), ...(options?.keepalive ? { keepalive: true } : {}) }); return 'ok'; }
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
  type Read = Awaited<ReturnType<ModelPrefsServer['read']>>;
  type BatchRead = { runtimeKey: string; promise: Promise<Read>; result?: Read };
  // The batch's first read starts at its first pick, so closing the page needs only the conditional write, which a
  // keepalive request carries past unload (a read-then-write started at unload cannot finish). If-Match still
  // refuses the write if the settings changed after this read.
  let base: BatchRead | null = null;
  let busy = 0;

  const apply = async (changes: Array<{ prev: ModelPrefs; next: ModelPrefs }>, runtimeKey: string,
    first: BatchRead | null, keepalive: boolean) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { prefs, etag } = attempt === 0 && first ? first.result ?? await first.promise : await server.read();
      if (runtimeKey !== getRuntimeKey()) return;
      let current = prefs, touched: Partial<ModelPrefs> = {};
      for (const change of changes) {
        const delta = mergeExplicitChange(change.prev, change.next, current);
        current = { ...current, ...delta }; touched = { ...touched, ...delta };
      }
      if (Object.keys(touched).length === 0) return;
      if (await server.write(touched, etag, keepalive ? { keepalive } : undefined) === 'ok') return;
    }
  };

  // One save at a time, in the order the user acted: each batch waits for the previous one to finish, then applies
  // its own change onto a fresh read, so an older save can never land after (and undo) a newer choice.
  let queue: Promise<void> = Promise.resolve();
  const flush = (keepalive = false) => {
    timer = null;
    const runtimeKey = scheduledRuntimeKey, changes = pending, first = base?.runtimeKey === runtimeKey ? base : null;
    scheduledRuntimeKey = null; pending = []; base = null;
    if (!runtimeKey || runtimeKey !== getRuntimeKey() || changes.length === 0) return;
    busy += 1;
    queue = queue.then(() => apply(changes, runtimeKey, first, keepalive)).catch((error: unknown) => {
      console.warn('Model preferences were not saved:', error);
    }).finally(() => { busy -= 1; });
  };

  // Closing or hiding the page does not wait for the debounce (a pick then an immediate close was lost).
  const flushNow = () => {
    if (timer === null) return;
    window.clearTimeout(timer);
    flush(true);
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
  const hasLifecycleEvents = typeof document !== 'undefined' && typeof window.addEventListener === 'function';
  if (hasLifecycleEvents) {
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
  }

  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    scheduledRuntimeKey = null;
    pending = [];
    base = null;
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
    // Only while no earlier save is in flight: a read taken then could not see that save.
    if (!base && busy === 0) {
      const read: BatchRead = { runtimeKey: scheduledRuntimeKey, promise: server.read() };
      read.promise.then((result) => { read.result = result; }, () => { if (base === read) base = null; });
      base = read;
    }
    timer = window.setTimeout(() => flush(), 1200);
  });

  return () => {
    unsubscribe();
    unsubscribeRuntime();
    if (hasLifecycleEvents) {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};
