import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { restoreManagedSessionSelection, useSessionUIStore } from '@/sync/session-ui-store';
import { noteRememberedGone } from '@/sync/gone-session-notice';
import { persistLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey, captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { useHumanAuth } from '@/lib/human-auth';
import { readTabSession, recordTabShownSession, tabSessionNamespace } from './tab-session-route';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { isVSCodeRuntime } from '@/lib/desktop';
import { capturePersonalSidebarAdmission, isPersonalSidebarAdmissionCurrent } from '@/lib/sidebar-view';

/** Keep route intent through discovery; unknown membership is not an absent session. */
export async function openSessionFromRoute(sessionId: string, options?: { initial?: boolean; personalReveal?: boolean }): Promise<void> {
  const scope = captureRuntimeRequestScope();
  const revision = useSessionUIStore.getState().sessionRevealRevision;
  const personal = options?.personalReveal !== false && !isVSCodeRuntime() && useHumanAuth.getState().enabled;
  const preferenceAdmission = personal ? capturePersonalSidebarAdmission() : undefined;
  const id = sessionId.trim();
  if (!id) return;
  const startedAt = Date.now();
  // This navigation is the person's newest choice: an older open still waiting for its project gives way now, before
  // discovery could admit and open it (#608).
  if (useProjectsStore.getState().managedSessionHold?.sessionId !== id) useProjectsStore.getState().dropPendingOpen();
  const runtimeKey = getRuntimeKey();
  const initial = useSessionUIStore.getState();
  const previous = readLastActiveSession(runtimeKey);
  const directoryHint = previous?.sessionId === id ? previous.directory : initial.getDirectoryForSession(id) ?? null;
  persistLastActiveSession(runtimeKey, { sessionId: id, directory: directoryHint });
  let routeRevision = revision;
  const current = () => isRuntimeRequestScopeCurrent(scope) && readLastActiveSession(runtimeKey)?.sessionId === id
    && (!personal || (preferenceAdmission !== undefined && isPersonalSidebarAdmissionCurrent(preferenceAdmission)
      && useSessionUIStore.getState().sessionRevealRevision === routeRevision));
  const namespace = personal ? await tabSessionNamespace(scope) : null;
  if (!current() || useSessionUIStore.getState().sessionRevealRevision !== revision) return;
  const ownReload = Boolean(options?.initial && namespace && readTabSession(namespace) === id);
  const ticket = personal && namespace && !ownReload ? initial.beginSessionReveal(scope, preferenceAdmission) : undefined;
  routeRevision = ticket?.revision ?? revision;

  const status = useProjectsStore.getState().managedCatalogStatus;
  if (!isVSCodeRuntime() && status !== 'stock' && status !== 'ready') {
    await refreshManagedProjects().catch(() => undefined);
    if (!current()) return;
    const projects = useProjectsStore.getState();
    if (projects.managedCatalogStatus !== 'ready' && projects.managedCatalogStatus !== 'stock') return;
  }
  if (!current()) return;
  // Preserve stock's immediate selection while its owning directory is discovered.
  if (!useProjectsStore.getState().managedCatalogAdmitted && initial.currentSessionId !== id) {
    initial.setCurrentSession(id, initial.getDirectoryForSession(id), personal ? 'restore' : undefined);
  }
  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot || !current()) return;
  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId && latest.currentSessionId !== id && latest.currentSessionId !== initial.currentSessionId) return;
  // An open the person made after this navigation began (still waiting for its project) is the newer choice (#608).
  const hold = useProjectsStore.getState().managedSessionHold;
  if (hold?.pending && hold.sessionId !== id && hold.since >= startedAt) return;
  if (useProjectsStore.getState().managedCatalogAdmitted) noteRememberedGone(snapshot.activeSessions, { chosen: true }); // smarty-code#775.
  const session = useProjectsStore.getState().managedCatalogAdmitted
    ? restoreManagedSessionSelection(snapshot.activeSessions, { chosen: true, reveal: !personal }) // The route owns its one-shot ticket.
    : [...snapshot.activeSessions, ...snapshot.archivedSessions].find(entry => entry.id === id);
  if (!session) return;
  const directory = resolveGlobalSessionDirectory(session);
  const selected = useSessionUIStore.getState();
  if (!directory) return;
  if (selected.currentSessionId !== id || directory !== selected.currentSessionDirectory) {
    selected.setCurrentSession(id, directory, personal ? 'restore' : undefined);
  }
  if (!current() || useSessionUIStore.getState().currentSessionId !== id) return;
  if (ticket) useSessionUIStore.getState().publishSessionReveal(ticket, id);
  if (namespace && (!ticket || ticket.revision === useSessionUIStore.getState().sessionRevealRevision)) {
    recordTabShownSession(scope, namespace, id);
  }
}
