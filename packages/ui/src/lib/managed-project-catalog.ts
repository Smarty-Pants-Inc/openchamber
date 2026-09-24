import { z } from 'zod';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';
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
    if (row.workspaces && row.workspaces.length > 0) project.workspaces = row.workspaces.map(workspace => ({ ...workspace }));
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

const trimSlashes = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') : path;

/** A saved selection the live catalog does not admit: its identities and a display name. */
type StaleManagedSelection = { identities: string[]; name: string };

// One saved selection may arrive as a cached path first and as a settings project id later, so
// it is keyed by its saved path (and that path's derived id) whenever the path is known.
const pathIdentities = (path: string) => [`path:${path}`, `project:${createProjectIdFromPath(path)}`];

/** Check the saved pointers (active project, else last directory), never the presentation selection. */
export function staleManagedSelection(live: readonly ProjectEntry[], saved: readonly ProjectEntry[],
  activeProjectId: string | null, lastDirectory: string | null): StaleManagedSelection | null {
  if (activeProjectId && !live.some(project => project.id === activeProjectId)) {
    const project = saved.find(entry => entry.id === activeProjectId);
    const identities = project ? [`project:${activeProjectId}`, ...pathIdentities(trimSlashes(project.path))]
      : [`project:${activeProjectId}`];
    return { identities, name: project?.label || project?.path || activeProjectId };
  }
  if (!lastDirectory) return null;
  const path = trimSlashes(lastDirectory);
  if (live.some(project => trimSlashes(project.path) === path)) return null;
  const project = saved.find(entry => trimSlashes(entry.path) === path);
  return { identities: pathIdentities(path), name: project?.label || path };
}

const notedStaleSelections = new Set<string>();
/** Tell the user once per runtime and saved identity that the view fell back; nothing is written.
 * The note waits for the current turn so it names the final selection (session restoration included). */
export function noteStaleManagedSelection(runtime: string, stale: StaleManagedSelection | null,
  shown: () => ProjectEntry | undefined) {
  if (!stale) return;
  const keys = stale.identities.map(identity => `${runtime}\n${identity}`);
  if (keys.some(key => notedStaleSelections.has(key))) return;
  for (const key of keys) notedStaleSelections.add(key);
  queueMicrotask(() => {
    const project = shown();
    // Nothing shown (empty catalog): no truthful note yet; a later publication may give one.
    if (!project) { for (const key of keys) notedStaleSelections.delete(key); return; }
    toast.info(formatMessage(useI18nStore.getState().dictionary, 'projects.managedCatalog.staleSelection',
      { saved: stale.name, shown: project.label || project.path }));
  });
}
