import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { readPersonalSidebarOwner } from '@/lib/sidebar-view';
import { isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';

/** Only this tab's admitted shown selection can classify an initial URL as reload restoration. */
export async function tabSessionNamespace(scope: RuntimeRequestScope): Promise<string | null> {
  const owner = await readPersonalSidebarOwner(scope).catch(() => null);
  return owner && isRuntimeRequestScopeCurrent(scope)
    ? `oc.tabSession.v1:${JSON.stringify([scope.runtimeKey, owner.issuer, owner.subject])}` : null;
}

export function readTabSession(namespace: string): string | null {
  return getSafeSessionStorage().getItem(namespace);
}

export function recordTabShownSession(scope: RuntimeRequestScope, namespace: string, sessionId: string | null): void {
  if (!isRuntimeRequestScopeCurrent(scope)) return;
  const ui = useSessionUIStore.getState();
  if (ui.currentSessionId !== sessionId) return;
  if (sessionId === null) { getSafeSessionStorage().removeItem(namespace); return; }
  const catalog = useProjectsStore.getState();
  const global = useGlobalSessionsStore.getState();
  if ((catalog.managedCatalogStatus !== 'ready' && catalog.managedCatalogStatus !== 'stock') || global.status !== 'ready' || !global.hasLoaded) return;
  const session = global.activeSessions.find(entry => entry.id === sessionId);
  const directory = session && resolveGlobalSessionDirectory(session);
  if (!directory || directory !== ui.currentSessionDirectory) return;
  if (catalog.managedCatalogAdmitted && !visibleProjects(catalog).some(project => project.path === directory)) return;
  getSafeSessionStorage().setItem(namespace, sessionId);
}
