import type { ProjectEntry, SettingsAPI, SettingsPayload } from '@/lib/api/types';

// JSON object key order is not part of a settings snapshot; keep array order and every field.
const snapshot = (value: ProjectEntry | SettingsPayload | string[] | undefined) => JSON.stringify(value,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- JSON replacers visit containers and scalars; only object keys are sorted.
  (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

const index = (projects: ProjectEntry[]) => {
  const result = new Map(projects.map(project => [project.id, project]));
  if (result.size !== projects.length) throw new Error('Duplicate project IDs in settings');
  return result;
};

/** Merge independent project edits; conflicting edits to one entry or order require user resolution. */
export function mergeProjectSettings(base: ProjectEntry[], current: ProjectEntry[], desired: ProjectEntry[]): ProjectEntry[] {
  const before = index(base), latest = index(current), next = index(desired);
  const merged = new Map(latest);
  for (const id of new Set([...before.keys(), ...next.keys()])) {
    const oldValue = snapshot(before.get(id)), newValue = snapshot(next.get(id));
    if (oldValue === newValue) continue;
    const currentValue = snapshot(latest.get(id));
    if (currentValue !== oldValue && currentValue !== newValue) {
      throw new Error('Projects changed before this update could be saved');
    }
    const replacement = next.get(id);
    if (replacement) merged.set(id, replacement);
    else merged.delete(id);
  }

  const commonOrder = (projects: ProjectEntry[]) => projects.map(project => project.id)
    .filter(id => before.has(id) && latest.has(id) && next.has(id));
  const beforeOrder = snapshot(commonOrder(base));
  const currentOrder = snapshot(commonOrder(current));
  const desiredOrder = snapshot(commonOrder(desired));
  const reordered = desiredOrder !== beforeOrder;
  if (reordered && currentOrder !== beforeOrder && currentOrder !== desiredOrder) {
    throw new Error('Project order changed before this update could be saved');
  }
  const order = reordered ? [...desired, ...current] : [...current, ...desired];
  return [...new Set(order.map(project => project.id))].flatMap(id => {
    const project = merged.get(id);
    return project ? [project] : [];
  });
}

/** Only a confirmed conditional PUT rejection may use this error, never an uncertain transport failure. */
export class SettingsConflictError extends Error { override name = 'SettingsConflictError'; }

/** Recover one unrelated revision change, without changing the patch or weakening its precondition. */
export async function saveProjectSettings(api: SettingsAPI, changes: Partial<SettingsPayload>,
  base: ProjectEntry[] | undefined, isCurrent: () => boolean, isLatestMutation: () => boolean,
): Promise<SettingsPayload | null> {
  const current = await api.load();
  if (!isCurrent()) return null;
  if (!current.revision) throw new Error('Project updates require conditional settings support');
  if (base === undefined) throw new Error('Project update has no original snapshot');
  if (changes.projects === undefined) throw new Error('Project update has no desired snapshot');
  const patch = structuredClone({ ...changes,
    projects: mergeProjectSettings(base, current.settings.projects ?? [], changes.projects) });
  const affectedFields = (settings: SettingsPayload) => snapshot(Object.fromEntries(
    Object.entries(settings).filter(([key]) => Object.hasOwn(patch, key))));
  const before = affectedFields(current.settings);
  try {
    return await api.save(patch, { ifMatch: current.revision });
  } catch (error) {
    if (!(error instanceof SettingsConflictError) || !isCurrent() || !isLatestMutation()) throw error;
    const fresh = await api.load();
    if (!isCurrent()) return null;
    // ponytail: stop on overlap, a stale read, or newer local intent. Persistent contention needs user resolution.
    if (!isLatestMutation() || !fresh.revision || fresh.revision === current.revision
      || affectedFields(fresh.settings) !== before) throw error;
    return api.save(patch, { ifMatch: fresh.revision });
  }
}
