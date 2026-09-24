import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { readManagedCatalog, MANAGED_CATALOG_HEADER, MANAGED_CATALOG_VERSION } from './managed-project-catalog';

const REFRESH_RETRIES = 2;
const REFRESH_RETRY_DELAY_MS = 150;
let revision = 0;
let pending: Promise<void> | undefined;
let pendingScope: ReturnType<typeof captureRuntimeRequestScope> | undefined;

// Uses the existing endpoint lifecycle; never starts a timer or writes settings.
subscribeRuntimeEndpointChanged(() => {
  revision++;
  pending = undefined;
  pendingScope = undefined;
  useProjectsStore.getState().resetManagedCatalog();
});

/** Called by existing bootstrap/reconnect/list refresh, not a second discovery loop. */
export function refreshManagedProjects(fresh = false): Promise<void> {
  if (isVSCodeRuntime(getRegisteredRuntimeAPIs())) return Promise.resolve();
  if (!fresh && pending && pendingScope && isRuntimeRequestScopeCurrent(pendingScope)) return pending;
  const scope = captureRuntimeRequestScope();
  const requestRevision = ++revision;
  const current = () => requestRevision === revision && isRuntimeRequestScopeCurrent(scope);
  // One sample of both reads. Throws on a failed or inconsistent sample; publishes nothing then.
  const sample = async () => {
    // This SDK is runtime-scoped, NOT directory-scoped: no directory query/header.
    const sdk = opencodeClient.getSdkClient();
    const result = await sdk.project.list();
    if (!current()) return;
    if (result.response.ok && result.response.headers.get(MANAGED_CATALOG_HEADER) === MANAGED_CATALOG_VERSION) {
      useProjectsStore.getState().admitManagedCatalog();
    }
    const rows = readManagedCatalog(result.response, result.data, useProjectsStore.getState().managedCatalogAdmitted);
    if (rows === null) {
      useProjectsStore.setState({ managedCatalogStatus: 'stock' });
      return;
    }
    // Inclusive paginated global read. Do not substitute a scoped/current-project read.
    // Failure of either read is nonauthoritative; no partial empty publication.
    const baselineRevision = useGlobalSessionsStore.getState().mutationRevision;
    const sessions = await listGlobalSessionPages(sdk, { archived: true, narrowToArchived: false, pageSize: 500 });
    if (!current()) return;
    const allowed = new Set(rows.map(row => row.worktree));
    if (sessions.some(session => !allowed.has(session.directory))) throw new Error('Catalog changed during session read');
    useProjectsStore.getState().applyManagedCatalog(rows);
    if (!current()) return;
    useGlobalSessionsStore.getState().applyManagedSessions(sessions, baselineRevision, allowed);
  };
  const request = (async () => {
    try {
      // A project admitted between the two reads, or a transient read failure, is retried a
      // bounded number of times before the status becomes unavailable (#126 item 12). Rows
      // already applied are never cleared on failure.
      for (let attempt = 0; ; attempt++) {
        try { await sample(); return; } catch (error) {
          if (!current() || attempt >= REFRESH_RETRIES) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, REFRESH_RETRY_DELAY_MS * (attempt + 1)));
        if (!current()) return;
      }
    } catch {
      if (current()) useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
    } finally {
      // A discarded sample is not completed discovery for callers awaiting it.
      if (requestRevision !== revision && isRuntimeRequestScopeCurrent(scope) && pending) await pending;
    }
  })();
  pending = request;
  pendingScope = scope;
  void request.finally(() => {
    if (pending === request) { pending = undefined; pendingScope = undefined; }
  });
  return request;
}
