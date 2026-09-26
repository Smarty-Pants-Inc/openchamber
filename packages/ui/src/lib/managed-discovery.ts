import { useProjectsStore } from '@/stores/useProjectsStore';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

type DiscoveryState = { managedCatalogStatus: string; managedCatalogStockConfirmed: boolean; managedRows: unknown[] | null };

/** Discovery has answered once it published projects or confirmed a stock server (both reset on an endpoint change). */
export const discoveryAnswered = (s: DiscoveryState) =>
  s.managedCatalogStatus === 'stock' || s.managedCatalogStockConfirmed || s.managedRows !== null;

/**
 * Whether project discovery has not answered yet (smarty-code MVP 1 G13): still unknown, or unavailable while it retries
 * before it ever answered. Then nothing may use the home fallback: no capability check and no session start.
 */
export const discoveryPendingFor = (status: string, answered: boolean) => status === 'unknown' || (status === 'unavailable' && !answered);

/** The same, now, from the projects store; never pending in VS Code, which has no managed discovery. */
export function discoveryPendingNow() {
  if (isVSCodeRuntime(getRegisteredRuntimeAPIs())) return false;
  const state = useProjectsStore.getState();
  return discoveryPendingFor(state.managedCatalogStatus, discoveryAnswered(state));
}
