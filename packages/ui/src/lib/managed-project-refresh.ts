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
// The first discovery gets the same limit as later refreshes (smarty-code MVP 1 G13): on a loaded host a 10 s limit
// declared a working catalog unavailable.
export const DISCOVERY_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 30_000;
// Test seam: the waits above, shortened in tests.
const limits = { first: DISCOVERY_TIMEOUT_MS, later: REFRESH_TIMEOUT_MS };
export const setCatalogReadLimitsForTest = (first: number, later: number) => { limits.first = first; limits.later = later; };
/** While the catalog is unavailable, discovery is retried on its own after these delays (the last one repeats). */
export const UNAVAILABLE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
class SlowRefresh extends Error {
  constructor(readonly first: boolean) { super(first ? 'Project catalog read timed out' : 'Project catalog refresh timed out'); }
}
let revision = 0;
let pending: Promise<void> | undefined;
let pendingScope: ReturnType<typeof captureRuntimeRequestScope> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined, retryScope: ReturnType<typeof captureRuntimeRequestScope> | undefined;
let retryAttempt = 0;
// A sample that outlived its wait and is still running. Slowness is not failure (smarty-code#113: a fresh profile's
// first discovery read can take over 30 s on a loaded host): it keeps running and publishes when it answers, and
// nothing supersedes it meanwhile, not a retry and not an ordinary refresh.
let slowSample: { run: Promise<void>; scope: ReturnType<typeof captureRuntimeRequestScope>; revision: number } | undefined;
// Only the newest request's slow sample counts: a fresh refresh supersedes it (its result is not published either).
const slowSampleCurrent = () => slowSample !== undefined && slowSample.revision === revision
  && isRuntimeRequestScopeCurrent(slowSample.scope);
const stopRetrying = () => { clearTimeout(retryTimer); retryTimer = undefined; retryScope = undefined; retryAttempt = 0; };

/**
 * An unavailable catalog is retried on its own, with backoff, until a sample answers (smarty-code MVP 1 G13): before,
 * a failed first discovery stayed unavailable until a reconnect or a user action. One timer at most; an endpoint
 * change or an answered sample stops it. Never writes settings.
 */
function retryWhileUnavailable(scope: ReturnType<typeof captureRuntimeRequestScope>) {
  // One timer, for the current scope: a timer left from an older runtime or auth scope is replaced, not trusted.
  if (retryTimer && retryScope !== undefined && isRuntimeRequestScopeCurrent(retryScope)) return;
  if (retryTimer) stopRetrying();
  retryScope = scope;
  const delay = UNAVAILABLE_RETRY_DELAYS_MS[Math.min(retryAttempt, UNAVAILABLE_RETRY_DELAYS_MS.length - 1)];
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = undefined; retryScope = undefined;
    if (!isRuntimeRequestScopeCurrent(scope) || useProjectsStore.getState().managedCatalogStatus !== 'unavailable') { retryAttempt = 0; return; }
    // A slow sample is still running: wait for its answer rather than supersede it.
    if (slowSampleCurrent()) { retryWhileUnavailable(scope); return; }
    void refreshManagedProjects(true);
  }, delay);
}

// Uses the existing endpoint lifecycle; its only timer is the unavailable-catalog retry above.
subscribeRuntimeEndpointChanged(() => {
  revision++;
  pending = undefined;
  pendingScope = undefined;
  slowSample = undefined;
  stopRetrying();
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
  // A slow sample is still running: an ordinary refresh waits for it (bounded) instead of starting over.
  if (!fresh && slowSampleCurrent()) {
    return Promise.race([slowSample!.run.catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, limits.later))]);
  }
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
  // Every attempt, with the bounded retries for a transient failure or a catalog changed mid-read (#126 item 12).
  // Rows already applied are never cleared on failure. Each read is bounded by the SDK (discovery reads 120 s).
  const attempts = async () => {
    for (let attempt = 0; ; attempt++) {
      try { await sample(); return; } catch (error) {
        if (!current() || attempt >= REFRESH_RETRIES) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, REFRESH_RETRY_DELAY_MS * (attempt + 1)));
      if (!current()) return;
    }
  };
  const failed = (error: unknown) => {
    if (!current()) return;
    // The banner alone does not say which read or check failed (R3.5 live leg); name it for diagnosis.
    console.warn('[managed-catalog] refresh failed:', error instanceof Error ? error.message : String(error));
    useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
    retryWhileUnavailable(scope);
  };
  const answered = () => {
    if (current() && useProjectsStore.getState().managedCatalogStatus !== 'unavailable') stopRetrying();
  };
  const request = (async () => {
    const first = useProjectsStore.getState().managedCatalogStatus === 'unknown';
    const run = attempts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([run, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SlowRefresh(first)), first ? limits.first : limits.later);
      })]);
      answered();
    } catch (error) {
      if (!(error instanceof SlowRefresh)) { failed(error); return; }
      // Slow is not failed: the first discovery stays 'Loading projects…' (status unknown), a later refresh keeps the
      // published catalog, and the attempts keep running. Their answer decides: success publishes (and replaces an
      // 'unavailable' banner), an error answer marks the catalog unavailable. Callers stop waiting now.
      console.warn(first ? '[managed-catalog] first discovery is slow; still loading' : '[managed-catalog] refresh is slow; keeping the published catalog');
      const tracked = { run, scope, revision: requestRevision };
      slowSample = tracked;
      void run.then(answered, failed).finally(() => { if (slowSample === tracked) slowSample = undefined; });
    } finally {
      clearTimeout(timer);
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
