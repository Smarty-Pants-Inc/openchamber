import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { restoreManagedSessionSelection, useSessionUIStore } from '@/sync/session-ui-store';
import { persistLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { isVSCodeRuntime } from '@/lib/desktop';

/** Keep route intent through discovery; unknown membership is not an absent session. */
export async function openSessionFromRoute(sessionId: string): Promise<void> {
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
  const current = () => getRuntimeKey() === runtimeKey && readLastActiveSession(runtimeKey)?.sessionId === id;

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
    initial.setCurrentSession(id, initial.getDirectoryForSession(id));
  }
  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot || !current()) return;
  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId && latest.currentSessionId !== id && latest.currentSessionId !== initial.currentSessionId) return;
  // An open the person made after this navigation began (still waiting for its project) is the newer choice (#608).
  const hold = useProjectsStore.getState().managedSessionHold;
  if (hold?.pending && hold.sessionId !== id && hold.since >= startedAt) return;
  const session = useProjectsStore.getState().managedCatalogAdmitted
    ? restoreManagedSessionSelection(snapshot.activeSessions, { chosen: true }) // The person's navigation.
    : [...snapshot.activeSessions, ...snapshot.archivedSessions].find(entry => entry.id === id);
  if (!session) return;
  const directory = resolveGlobalSessionDirectory(session);
  const selected = useSessionUIStore.getState();
  if (!directory || (selected.currentSessionId === id && directory === selected.currentSessionDirectory)) return;
  selected.setCurrentSession(id, directory);
}
