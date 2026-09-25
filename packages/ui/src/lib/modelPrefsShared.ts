// smarty-code#126 F6 (the #117 rule): an explicit pick writes only what it changed, applied to the server's current
// copy. Local entries that a session restore added never reach the shared settings, not even with a later pick.
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
const same = (a: readonly Item[], b: readonly Item[]) => a.length === b.length && a.every((item, i) => key(item) === key(b[i]!));

/** One list's explicit change, applied to the shared list. A recent list keeps its most recent pick first; restores add
 * local recents, so only the pick itself goes onto the server's list. */
function mergeList(field: ListField, prev: readonly Item[], next: readonly Item[], shared: readonly Item[]): Item[] {
  if (RECENTS.has(field)) {
    const picked = next[0];
    if (!picked || (prev[0] && key(prev[0]) === key(picked))) return [...shared];
    return [picked, ...shared.filter(entry => key(entry) !== key(picked))].slice(0, RECENT_LIMIT);
  }
  // Favourites, hidden models and collapsed providers change only by the user's own edits (never by a restore), and
  // their order is the user's (a drag, or a new favourite inserted first): write the list as the user left it.
  return [...next];
}

/**
 * The fields one explicit change touched, applied to `shared` (the server's current copy). Returns only those
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
      const before = prev.recentEfforts[model] ?? [], after = next.recentEfforts[model];
      if (!after) { delete merged[model]; continue; }
      // Only the efforts this action added, onto the model's shared list: a restored effort on the same model stays
      // local (OC#194 review).
      const added = after.filter(variant => !before.includes(variant));
      merged[model] = [...added, ...(merged[model] ?? []).filter(variant => !added.includes(variant))].slice(0, RECENT_LIMIT);
    }
    changes.recentEfforts = merged;
  }
  return changes;
}

