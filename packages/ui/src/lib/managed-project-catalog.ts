import { z } from 'zod';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import type { WorktreeMetadata } from '@/types/worktree';

export const MANAGED_CATALOG_HEADER = 'x-smarty-code-catalog';
export const MANAGED_CATALOG_VERSION = 'managed-v1';
const directory = z.string().min(1).refine(path =>
  // eslint-disable-next-line no-control-regex -- Reject control bytes in native catalog paths.
  !/[\u0000-\u001f]/.test(path) && (path.startsWith('/') || /^[A-Za-z]:\//.test(path))
  && !path.split('/').some(part => part === '.' || part === '..'));
const rows = z.array(z.object({ id: z.string().min(1), worktree: directory, name: z.string().optional(),
  // managed-v1 grouping fields (smarty-code#126): a linked worktree names its published repository root.
  parent: directory.optional(),
  workspaces: z.array(z.object({ id: z.string().min(1), label: z.string() })).optional() }));
export type ManagedProject = z.infer<typeof rows>[number];
export type ManagedCatalogStatus = 'unknown' | 'stock' | 'ready' | 'unavailable';

/** Parse the SDK's untrusted response here; a marker is not payload validation.
 * Absence of the marker is stock only before this runtime has ever admitted it. */
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
  const members = new Set(rows.map(row => row.worktree));
  return rows.map(row => {
    const saved = bookmarks.find(project => project.path === row.worktree);
    const project: ProjectEntry = saved ? { ...saved } : {
      id: createProjectIdFromPath(row.worktree), path: row.worktree, addedAt: 0, lastOpenedAt: 0,
    };
    // The catalog's name is the Herdr workspace label: it wins over a saved bookmark label.
    if (row.name) project.label = row.name;
    if (row.parent && row.parent !== row.worktree && members.has(row.parent)) project.parent = row.parent;
    return project;
  });
}

/**
 * Herdr's tree: a linked worktree with a published root renders under that root, as a worktree
 * group, not as its own top-level project. Its sessions stay attributed to its own directory.
 */
export function nestManagedProjects<P extends Pick<ProjectEntry, 'path' | 'label' | 'parent'>>(
  projects: readonly P[], worktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>,
): { topLevel: P[]; worktreesByProject: Map<string, WorktreeMetadata[]> } {
  const roots = new Set(projects.filter(project => !project.parent).map(project => project.path));
  const children = projects.filter(project => project.parent && roots.has(project.parent));
  if (children.length === 0) return { topLevel: [...projects], worktreesByProject: new Map(worktreesByProject) };
  const nested = new Map(worktreesByProject);
  for (const child of children) {
    const parent = child.parent!;
    const label = child.label || child.path.split('/').filter(Boolean).at(-1) || child.path;
    const existing = nested.get(parent) ?? [];
    const found = existing.find(meta => meta.path === child.path);
    const entry: WorktreeMetadata = found ? { ...found, label } : { path: child.path, projectDirectory: parent, branch: '', label };
    nested.set(parent, [...existing.filter(meta => meta.path !== child.path), entry]);
  }
  return { topLevel: projects.filter(project => !children.includes(project)), worktreesByProject: nested };
}

export function managedActiveProject(projects: readonly ProjectEntry[], active: string | null): string | null {
  return projects.some(project => project.id === active) ? active : projects[0]?.id ?? null;
}
