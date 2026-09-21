import { z } from 'zod';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';

export const MANAGED_CATALOG_HEADER = 'x-smarty-code-catalog';
export const MANAGED_CATALOG_VERSION = 'managed-v1';
const directory = z.string().min(1).refine(path =>
  // eslint-disable-next-line no-control-regex -- Reject control bytes in native catalog paths.
  !/[\u0000-\u001f]/.test(path) && (path.startsWith('/') || /^[A-Za-z]:\//.test(path))
  && !path.split('/').some(part => part === '.' || part === '..'));
const rows = z.array(z.object({ id: z.string().min(1), worktree: directory, name: z.string().optional() }));
export type ManagedProject = z.infer<typeof rows>[number];
export type ManagedCatalogStatus = 'unknown' | 'stock' | 'ready' | 'unavailable';

/** Absence of the marker is stock only before this runtime has ever admitted it. */
export function readManagedCatalog(response: Response, data: unknown, admitted: boolean): ManagedProject[] | null {
  if (!response.ok) throw new Error('Project catalog unavailable');
  if (response.headers.get(MANAGED_CATALOG_HEADER) !== MANAGED_CATALOG_VERSION) {
    if (admitted) throw new Error('Managed project capability disappeared');
    return null;
  }
  const parsed = rows.parse(data);
  if (new Set(parsed.map(row => row.worktree)).size !== parsed.length
    || new Set(parsed.map(row => row.id)).size !== parsed.length) throw new Error('Duplicate managed project');
  return parsed;
}

/** Bookmark metadata decorates live membership; bookmarks themselves never change. */
export function managedProjectView(rows: readonly ManagedProject[], bookmarks: readonly ProjectEntry[]): ProjectEntry[] {
  return rows.map(row => {
    const saved = bookmarks.find(project => project.path === row.worktree);
    return saved ? { ...saved } : {
      id: createProjectIdFromPath(row.worktree), path: row.worktree,
      ...(row.name ? { label: row.name } : {}), addedAt: 0, lastOpenedAt: 0,
    };
  });
}

export function managedActiveProject(projects: readonly ProjectEntry[], active: string | null): string | null {
  return projects.some(project => project.id === active) ? active : projects[0]?.id ?? null;
}
