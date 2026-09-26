import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';

/**
 * smarty-dev#777: a project added to a managed catalog now joins the page's open event stream (the gateway no longer
 * closes it), so the page no longer learns the new project from a reconnect. Its first event is that project's own
 * `server.connected`: a project the loaded catalog does not list refreshes the catalog, once per burst.
 *
 * A join that arrives while the catalog is not loaded yet (the first discovery, or a retry, still running) is kept,
 * not dropped (#282 review): that discovery may have read the project list before the project joined. Once the
 * catalog loads, a kept project it does not list refreshes it once.
 */
export const JOIN_DEBOUNCE_MS = 250;
let timer: ReturnType<typeof setTimeout> | undefined;
const waiting = new Set<string>();
let unsubscribe: (() => void) | undefined;

const unlisted = (directory: string) => !visibleProjects(useProjectsStore.getState()).some(project => project.path === directory);
const refreshSoon = () => {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void refreshManagedProjects(true); }, JOIN_DEBOUNCE_MS);
};
const settleWaiting = () => {
  const state = useProjectsStore.getState();
  if (state.managedCatalogStatus === 'stock') { waiting.clear(); unsubscribe?.(); unsubscribe = undefined; return; }
  if (state.managedCatalogStatus !== 'ready') return;
  const missing = [...waiting].some(unlisted);
  waiting.clear(); unsubscribe?.(); unsubscribe = undefined;
  if (missing) refreshSoon();
};

export function noticeProjectConnected(directory: string | undefined): void {
  if (!directory || directory === 'global') return;
  const status = useProjectsStore.getState().managedCatalogStatus;
  if (status === 'stock') return; // Not a managed catalog: projects are the person's own list.
  if (status !== 'ready') { // Discovery still running: keep the join and decide once the catalog loads.
    waiting.add(directory);
    unsubscribe ??= useProjectsStore.subscribe(settleWaiting);
    return;
  }
  if (unlisted(directory)) refreshSoon();
}
