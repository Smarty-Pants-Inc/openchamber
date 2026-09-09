import type { ProjectEntry } from '@/lib/api/types';

// JSON object key order is not part of a project snapshot; keep array order and every field.
const snapshot = (value: ProjectEntry | string[] | undefined) => JSON.stringify(value,
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
