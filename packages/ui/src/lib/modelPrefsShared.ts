// smarty-code#126 F6 (the #117 rule): an explicit pick writes only what it changed, merged onto the shared copy.
// Local entries that a session restore added never reach the shared settings, not even with a later pick.
type ModelRef = { providerID: string; modelID: string };
export type ModelPrefs = {
  favoriteModels: ModelRef[];
  hiddenModels: ModelRef[];
  collapsedModelProviders: string[];
  recentModels: ModelRef[];
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;
};
type ListField = Exclude<keyof ModelPrefs, 'recentEfforts'>;
const LIST_FIELDS: ListField[] = ['favoriteModels', 'hiddenModels', 'collapsedModelProviders', 'recentModels', 'recentAgents'];
const RECENTS: ReadonlySet<ListField> = new Set(['recentModels', 'recentAgents']);
const RECENT_LIMIT = 5;

type Item = ModelRef | string;
const key = (item: Item) => typeof item === 'string' ? item : `${item.providerID}\u0000${item.modelID}`;
const has = (list: readonly Item[], item: Item) => list.some(entry => key(entry) === key(item));
const same = (a: readonly Item[], b: readonly Item[]) => a.length === b.length && a.every((item, i) => key(item) === key(b[i]!));

/** One list's explicit change, applied to the shared list. A recent list keeps its most recent pick first. */
function mergeList(field: ListField, prev: readonly Item[], next: readonly Item[], shared: readonly Item[]): Item[] {
  if (RECENTS.has(field)) {
    const picked = next[0];
    if (!picked || (prev[0] && key(prev[0]) === key(picked))) return [...shared];
    return [picked, ...shared.filter(entry => key(entry) !== key(picked))].slice(0, RECENT_LIMIT);
  }
  const removed = prev.filter(item => !has(next, item)), added = next.filter(item => !has(prev, item));
  return [...shared.filter(item => !has(removed, item)), ...added.filter(item => !has(shared, item))];
}

/**
 * The fields one explicit change touched, merged onto `shared` (the server's copy as last known). Returns only those
 * fields; `shared` is not modified.
 */
export function mergeExplicitChange(prev: ModelPrefs, next: ModelPrefs, shared: ModelPrefs): Partial<ModelPrefs> {
  const changes: Partial<ModelPrefs> = {};
  for (const field of LIST_FIELDS) {
    if (same(prev[field], next[field])) continue;
    // SAFETY: each field keeps its own element type through mergeList.
    (changes as Record<ListField, Item[]>)[field] = mergeList(field, prev[field], next[field], shared[field]);
  }
  const efforts = Object.keys({ ...prev.recentEfforts, ...next.recentEfforts })
    .filter(model => !same(prev.recentEfforts[model] ?? [], next.recentEfforts[model] ?? []));
  if (efforts.length > 0) {
    const merged = { ...shared.recentEfforts };
    for (const model of efforts) {
      if (next.recentEfforts[model]) merged[model] = next.recentEfforts[model].slice(); else delete merged[model];
    }
    changes.recentEfforts = merged;
  }
  return changes;
}

export const copyModelPrefs = (prefs: ModelPrefs): ModelPrefs => ({
  favoriteModels: prefs.favoriteModels.slice(), hiddenModels: prefs.hiddenModels.slice(),
  collapsedModelProviders: prefs.collapsedModelProviders.slice(), recentModels: prefs.recentModels.slice(),
  recentAgents: prefs.recentAgents.slice(),
  recentEfforts: Object.fromEntries(Object.entries(prefs.recentEfforts).map(([model, variants]) => [model, variants.slice()])),
});
