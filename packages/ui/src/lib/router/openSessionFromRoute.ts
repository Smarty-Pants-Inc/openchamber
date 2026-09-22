import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { persistLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { isVSCodeRuntime } from '@/lib/desktop';

/** Keep route intent through discovery; unknown membership is not an absent session. */
export async function openSessionFromRoute(sessionId: string): Promise<void> {
  const id = sessionId.trim();
  if (!id) return;
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
  const session = [...snapshot.activeSessions, ...snapshot.archivedSessions].find(entry => entry.id === id);
  if (!session) return;
  const directory = resolveGlobalSessionDirectory(session);
  if (!directory || (latest.currentSessionId === id && directory === latest.currentSessionDirectory)) return;
  latest.setCurrentSession(id, directory);
}
