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
  return replayOperations(prev, next, shared);
}

const indexOf = (list: readonly Item[], item: Item) => list.findIndex(entry => key(entry) === key(item));

/**
 * Favourites, hidden models and collapsed providers: the user's action as operations (add x, remove x, move x before
 * its new successor), replayed onto the server's list (OC#194 review). Entries only the server has are kept; an add
 * of a present entry or a remove of an absent one is a no-op. x goes before the first of its new successors that the
 * server list has, else to the end.
 */
function replayOperations(prev: readonly Item[], next: readonly Item[], shared: readonly Item[]): Item[] {
  let result = shared.filter(entry => indexOf(next, entry) >= 0 || indexOf(prev, entry) < 0); // removals
  const place = (item: Item) => {
    result = result.filter(entry => key(entry) !== key(item));
    const successors = next.slice(indexOf(next, item) + 1);
    const at = successors.map(successor => indexOf(result, successor)).find(position => position >= 0);
    result = at === undefined ? [...result, item] : [...result.slice(0, at), item, ...result.slice(at)];
  };
  for (const item of next) if (indexOf(prev, item) < 0 && indexOf(result, item) < 0) place(item); // adds
  // A move: the one common entry whose removal makes the old and new orders agree (a drag moves one entry).
  const common = next.filter(item => indexOf(prev, item) >= 0), before = prev.filter(item => indexOf(next, item) >= 0);
  if (!same(common, before)) {
    const moved = common.find(item => same(common.filter(entry => key(entry) !== key(item)), before.filter(entry => key(entry) !== key(item))));
    for (const item of moved ? [moved] : common) place(item); // not a single move: follow the user's order
  }
  return result;
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

