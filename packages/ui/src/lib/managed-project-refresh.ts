import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { warmChatsRootDirectory } from './chatDirectories';
import { applyFleetSessionStatuses, getSessionStatusEventVersion } from '@/sync/global-session-status';
import { readManagedCatalog, MANAGED_CATALOG_HEADER, MANAGED_CATALOG_VERSION } from './managed-project-catalog';

const REFRESH_RETRIES = 2;
const REFRESH_RETRY_DELAY_MS = 150;
const DISCOVERY_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 30_000;
class SlowRefresh extends Error {
  constructor(readonly first: boolean) { super(first ? 'Project catalog read timed out' : 'Project catalog refresh timed out'); }
}
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

/**
 * Activity markers for every published session at once (#126 3.11: a remembered profile showed 9 busy sessions idle
 * until their directories bootstrapped). A managed gateway's unscoped /session/status covers the whole fleet, so it
 * reconciles the global status index per directory. Directory stores are untouched: they keep their scoped reads
 * (an unscoped map there made every store resync every fleet session, OC#145). Best effort; events keep it live.
 */
async function seedManagedActivity(sdk: ReturnType<typeof opencodeClient.getSdkClient>,
  sessions: readonly { id: string; directory: string }[], current: () => boolean): Promise<void> {
  if (sessions.length === 0) return;
  // Events that land while the read is in flight win over it.
  const versions = new Map(sessions.map(session => [session.id, getSessionStatusEventVersion(session.id)]));
  const result = await sdk.session.status().catch(() => null);
  if (!current() || !result?.data || typeof result.data !== 'object') return;
  applyFleetSessionStatuses(sessions, result.data as Record<string, { type?: string }>, versions);
}

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
    // Ungated: this read decides live membership after every stream close. Behind the shared background gate it
    // waited 13-18 s for git status polls, so a renamed or closed Herdr workspace showed late (#126 item 3). A
    // superseded sample stops before its next page or retry, so rapid reconnects leave at most one page request each.
    const sessions = await listGlobalSessionPages(sdk, { archived: true, narrowToArchived: false, pageSize: 500, ungated: true, isCurrent: current });
    if (!current()) return;
    const allowed = new Set(rows.map(row => row.worktree));
    if (sessions.some(session => !allowed.has(session.directory))) throw new Error('Catalog changed during session read');
    useProjectsStore.getState().applyManagedCatalog(rows);
    if (!current()) return;
    // Requests name only the reported chats root; know it before chat sessions publish (it never throws).
    await warmChatsRootDirectory();
    if (!current()) return;
    useGlobalSessionsStore.getState().applyManagedSessions(sessions, baselineRevision, allowed);
    void seedManagedActivity(sdk, sessions, current);
  };
  const request = (async () => {
    try {
      // A project admitted between the two reads, or a transient read failure, is retried a
      // bounded number of times before the status becomes unavailable (#126 item 12). Rows
      // already applied are never cleared on failure.
      for (let attempt = 0; ; attempt++) {
        // Bounded: startup scoped reads wait for first discovery, so a hung sample must end as "unavailable", not
        // "unknown"; a later sample that hangs ends too (callers await it) but keeps its status and published rows.
        const first = useProjectsStore.getState().managedCatalogStatus === 'unknown';
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([sample(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SlowRefresh(first)), first ? DISCOVERY_TIMEOUT_MS : REFRESH_TIMEOUT_MS);
          })]);
          return;
        } catch (error) {
          if (error instanceof SlowRefresh && !error.first) { console.warn('[managed-catalog] refresh is slow; keeping the published catalog'); return; }
          if (!current() || attempt >= REFRESH_RETRIES || error instanceof SlowRefresh) throw error;
        } finally { clearTimeout(timer); }
        await new Promise(resolve => setTimeout(resolve, REFRESH_RETRY_DELAY_MS * (attempt + 1)));
        if (!current()) return;
      }
    } catch (error) {
      if (!current()) return;
      // The banner alone does not say which read or check failed (R3.5 live leg); name it for diagnosis.
      console.warn('[managed-catalog] refresh failed:', error instanceof Error ? error.message : String(error));
      useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
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
