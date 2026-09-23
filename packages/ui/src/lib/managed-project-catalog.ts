import { z } from 'zod';
import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';

export const MANAGED_CATALOG_HEADER = 'x-smarty-code-catalog';
export const MANAGED_CATALOG_VERSION = 'managed-v1';
const directory = z.string().min(1).refine(path =>
  // eslint-disable-next-line no-control-regex -- Reject control bytes in native catalog paths.
  !/[\u0000-\u001f]/.test(path) && (path.startsWith('/') || /^[A-Za-z]:\//.test(path))
  && !path.split('/').some(part => part === '.' || part === '..'));
const rows = z.array(z.object({ id: z.string().min(1), worktree: directory, name: z.string().optional() }));
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
  return rows.map(row => {
    const saved = bookmarks.find(project => project.path === row.worktree);
    if (saved) return { ...saved };
    const project: ProjectEntry = {
      id: createProjectIdFromPath(row.worktree), path: row.worktree, addedAt: 0, lastOpenedAt: 0,
    };
    if (row.name) project.label = row.name;
    return project;
  });
}

export function managedActiveProject(projects: readonly ProjectEntry[], active: string | null): string | null {
  return projects.some(project => project.id === active) ? active : projects[0]?.id ?? null;
}

const trimSlashes = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') : path;

/** A saved selection the live catalog does not admit: its raw identity and a display name. */
type StaleManagedSelection = { identity: string; name: string };

/** Check the saved pointers (active project, else last directory), never the presentation selection. */
export function staleManagedSelection(live: readonly ProjectEntry[], saved: readonly ProjectEntry[],
  activeProjectId: string | null, lastDirectory: string | null): StaleManagedSelection | null {
  if (activeProjectId && !live.some(project => project.id === activeProjectId)) {
    const project = saved.find(entry => entry.id === activeProjectId);
    return { identity: `project:${activeProjectId}`, name: project?.label || project?.path || activeProjectId };
  }
  if (!lastDirectory) return null;
  const path = trimSlashes(lastDirectory);
  return live.some(project => trimSlashes(project.path) === path) ? null : { identity: `directory:${path}`, name: path };
}

const notedStaleSelections = new Set<string>();
/** Tell the user once per runtime and saved identity that the view fell back; nothing is written.
 * The note waits for the current turn so it names the final selection (session restoration included). */
export function noteStaleManagedSelection(runtime: string, stale: StaleManagedSelection | null,
  shown: () => ProjectEntry | undefined) {
  if (!stale) return;
  const key = `${runtime}\n${stale.identity}`;
  if (notedStaleSelections.has(key)) return;
  notedStaleSelections.add(key);
  queueMicrotask(() => {
    const project = shown();
    // Nothing shown (empty catalog): no truthful note yet; a later publication may give one.
    if (!project) { notedStaleSelections.delete(key); return; }
    toast.info(formatMessage(useI18nStore.getState().dictionary, 'projects.managedCatalog.staleSelection',
      { saved: stale.name, shown: project.label || project.path }));
  });
}
