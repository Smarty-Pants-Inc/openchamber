import React from 'react';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { refreshDesktopSettings } from '@/lib/persistence';
import { refreshGlobalSessions, refreshGlobalSessionsForDirectories, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { refreshManagedProjects } from '@/lib/managed-project-refresh';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { buildKnownSessionDirectories } from './sessionListDirectories';
import { useAuthoritativeSessionCleanup } from './useAuthoritativeSessionCleanup';
import { normalizePath } from '../utils';

const EMPTY_WORKTREES_BY_PROJECT = new Map();

type UseSessionListSyncOptions = {
  isVSCode: boolean;
};

export const useSessionListSync = ({
  isVSCode,
}: UseSessionListSyncOptions) => {
  const childStores = useChildStoreManager();
  const projects = useProjectsStore(visibleProjects);
  const managed = useProjectsStore(state => state.managedCatalogAdmitted);
  const catalogStatus = useProjectsStore(state => state.managedCatalogStatus);
  React.useEffect(() => { if (!isVSCode) void refreshManagedProjects(); }, [isVSCode]);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const availableWorktreesByProject = useSessionUIStore((state) => isVSCode ? EMPTY_WORKTREES_BY_PROJECT : state.availableWorktreesByProject);
  const knownDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: !isVSCode && !managed }),
    [availableWorktreesByProject, isVSCode, managed, projects],
  );
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const bootstrapDemandOwner = `session-list-sync:${React.useId()}`;

  // Until discovery answers, the directories in hand (home fallback, saved bookmarks) may not be admitted by a
  // managed gateway, which refuses them with 403 (#126 startup 403s). Stock discovery answers within a request.
  const discoveryPending = !isVSCode && catalogStatus === 'unknown';
  React.useEffect(() => {
    if (discoveryPending) return;
    childStores.setBootstrapDemand(bootstrapDemandOwner, buildSessionBootstrapDemands({
      knownDirectories,
      activeProjectDirectory: normalizePath(projects.find((project) => project.id === activeProjectId)?.path ?? null),
      activeProjectId,
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory,
      currentSessionDirectory,
      managed,
    }));
    return () => childStores.clearBootstrapDemand(bootstrapDemandOwner);
  }, [activeProjectId, bootstrapDemandOwner, childStores, currentDirectory, currentSessionDirectory, discoveryPending, knownDirectories, managed, projects]);

  const knownProjectSessionDirectoriesRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const directories = new Set(knownDirectories);
    const previous = knownProjectSessionDirectoriesRef.current;
    knownProjectSessionDirectoriesRef.current = directories;
    const added = previous ? [...directories].filter((directory) => !previous.has(directory)) : isVSCode ? [...directories] : [];
    if (added.length) void refreshGlobalSessionsForDirectories(added, getAllSyncSessions());
  }, [isVSCode, knownDirectories]);

  React.useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let refreshAll = false;
    let refreshSettings = false;
    const directories = new Set<string>();
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'scheduled-task-ran') refreshAll = true;
      else if (event.type === 'session-created') directories.add(event.directory);
      else if (event.type === 'settings-changed' && !isVSCode) refreshSettings = true;
      else return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null;
        if (refreshSettings) {
          refreshSettings = false;
          void refreshDesktopSettings();
        }
        if (refreshAll) {
          refreshAll = false;
          directories.clear();
          void refreshGlobalSessions(getAllSyncSessions());
          return;
        }
        const requested = [...directories];
        directories.clear();
        if (requested.length) void refreshGlobalSessionsForDirectories(requested, getAllSyncSessions());
      }, 500);
    });
    return () => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    };
  }, [isVSCode]);

  const cleanupSessions = React.useMemo(
    () => [...globalActiveSessions, ...archivedSessions],
    [archivedSessions, globalActiveSessions],
  );
  useAuthoritativeSessionCleanup({
    // Until capability is known, absence is not evidence of native deletion.
    enabled: isVSCode || (!managed && catalogStatus === 'stock'),
    hasAuthoritativeGlobalSessions,
    sessions: cleanupSessions,
  });
};
