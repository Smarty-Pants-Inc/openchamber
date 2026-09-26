import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';

/**
 * smarty-dev#777: a project added to a managed catalog now joins the page's open event stream (the gateway no longer
 * closes it), so the page no longer learns the new project from a reconnect. Its first event is that project's own
 * `server.connected`: a project the loaded catalog does not list refreshes the catalog, once per burst.
 */
export const JOIN_DEBOUNCE_MS = 250;
let timer: ReturnType<typeof setTimeout> | undefined;

export function noticeProjectConnected(directory: string | undefined): void {
  const state = useProjectsStore.getState();
  // Before the catalog has loaded, the page's own first read is still coming: nothing to add.
  if (!directory || directory === 'global' || !state.managedCatalogAdmitted || state.managedCatalogStatus !== 'ready') return;
  if (visibleProjects(state).some(project => project.path === directory)) return;
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void refreshManagedProjects(true); }, JOIN_DEBOUNCE_MS);
}
