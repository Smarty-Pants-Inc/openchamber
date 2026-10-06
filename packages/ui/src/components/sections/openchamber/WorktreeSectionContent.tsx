import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@opencode-ai/sdk/v2';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDeviceInfo } from '@/lib/device';
import { checkIsGitRepository } from '@/lib/gitApi';
import {
  getWorktreeSetupWaitEnabled,
  saveWorktreeSetupWaitEnabled,
} from '@/lib/openchamberConfig';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { sessionEvents } from '@/lib/sessionEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import { formatPathForDisplay, cn } from '@/lib/utils';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import { useI18n } from '@/lib/i18n';

export interface WorktreeSectionContentProps {
  projectRef?: { id: string; path: string } | null;
  /**
   * 'all' renders the bootstrap wait preference + the worktree list (settings
   * panel); 'list-only' renders just the list (the Worktrees page).
   */
  sections?: 'all' | 'list-only';
}

export const WorktreeSectionContent: React.FC<WorktreeSectionContentProps> = ({ projectRef: projectRefProp = null, sections = 'all' }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectPath = projectRefProp?.path ?? activeProject?.path ?? null;

  const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [waitForSetupCommands, setWaitForSetupCommands] = React.useState(false);
  const [isLoadingCommands, setIsLoadingCommands] = React.useState(false);
  const [isGitRepoLocal, setIsGitRepoLocal] = React.useState<boolean | null>(null);
  const [availableWorktrees, setAvailableWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = React.useState(false);

  const projectRef = React.useMemo(() => {
    if (projectRefProp?.id && projectRefProp?.path) {
      return { id: projectRefProp.id, path: projectRefProp.path };
    }
    if (!activeProject?.id || !projectPath) {
      return null;
    }
    return { id: activeProject.id, path: projectPath };
  }, [activeProject?.id, projectPath, projectRefProp?.id, projectRefProp?.path]);

  const refreshWorktrees = React.useCallback(async () => {
    if (!projectRef || isGitRepoLocal === false) return;

    try {
      const worktrees = await listProjectWorktrees(projectRef);
      setAvailableWorktrees(worktrees);
    } catch {
      // Ignore errors
    }
  }, [projectRef, isGitRepoLocal]);

  React.useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    setIsGitRepoLocal(null);

    (async () => {
      try {
        const repoStatus = await checkIsGitRepository(projectPath);
        if (cancelled) return;
        setIsGitRepoLocal(repoStatus);
      } catch {
        // Ignore errors
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  React.useEffect(() => {
    if (!projectRef) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    if (isGitRepoLocal === false) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    let cancelled = false;
    setIsLoadingWorktrees(true);
    setAvailableWorktrees([]);

    (async () => {
      try {
        const worktrees = await listProjectWorktrees(projectRef);
        if (cancelled) return;
        setAvailableWorktrees(worktrees);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoadingWorktrees(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef, isGitRepoLocal]);

  React.useEffect(() => {
    if (!projectRef) return;

    let cancelled = false;
    setIsLoadingCommands(true);

    (async () => {
      try {
        const waitForSetup = await getWorktreeSetupWaitEnabled(projectRef);
        if (!cancelled) {
          setWaitForSetupCommands(waitForSetup);
        }
      } catch {
        if (!cancelled) {
          setWaitForSetupCommands(false);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCommands(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef]);

  const handleWaitForSetupCommandsChange = React.useCallback((enabled: boolean) => {
    setWaitForSetupCommands(enabled);
    if (projectRef) {
      void saveWorktreeSetupWaitEnabled(projectRef, enabled);
    }
  }, [projectRef]);

  const handleDeleteWorktree = React.useCallback((worktree: WorktreeMetadata) => {
    const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedWorktreePath = normalize(worktree.path);

    const directSessions = sessions.filter((session) => {
      const metadata = getWorktreeMetadata(session.id);
      if (metadata?.path && normalize(metadata.path) === normalizedWorktreePath) {
        return true;
      }

      const sessionDir = (session as { directory?: string }).directory;
      if (sessionDir) {
        const normalizedSessionDir = normalize(sessionDir);
        if (normalizedSessionDir === normalizedWorktreePath) {
          return true;
        }
      }

      return false;
    });

    const directSessionIds = new Set(directSessions.map((s) => s.id));

    const allKnownSessions = [
      ...useGlobalSessionsStore.getState().activeSessions,
      ...useGlobalSessionsStore.getState().archivedSessions,
    ];

    const findSubsessions = (parentIds: Set<string>): Session[] => {
      const subsessions = allKnownSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        return parentID && parentIds.has(parentID);
      });
      if (subsessions.length === 0) {
        return [];
      }
      const subsessionIds = new Set(subsessions.map((s) => s.id));
      return [...subsessions, ...findSubsessions(subsessionIds)];
    };

    const allSubsessions = findSubsessions(directSessionIds);

    const seenIds = new Set<string>();
    const allSessions = [...directSessions, ...allSubsessions].filter((session) => {
      if (seenIds.has(session.id)) {
        return false;
      }
      seenIds.add(session.id);
      return true;
    });

    sessionEvents.requestDelete({
      sessions: allSessions,
      mode: 'worktree',
      worktree,
    });
  }, [sessions, getWorktreeMetadata]);

  const sessionsKey = React.useMemo(() => sessions.map(s => s.id).join(','), [sessions]);
  React.useEffect(() => {
    if (isGitRepoLocal && projectPath) {
      refreshWorktrees();
    }
  }, [sessionsKey, isGitRepoLocal, projectPath, refreshWorktrees]);

  const listTooltip = (
    <SettingsInfoHint>
      {t('settings.openchamber.worktrees.list.tooltip')}
    </SettingsInfoHint>
  );

  if (!projectPath) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.selectProject')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  if (isGitRepoLocal === false) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.gitOnly')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  return (
    <>
      {sections === 'all' ? (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        {isLoadingCommands ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.setup.loading')}</p>
        ) : (
          <div className={cn('space-y-2', PROJECT_SETTINGS_CONTROL_WIDTH)}>
            <label
              data-settings-item="projects.worktree.setup.wait"
              className="flex cursor-pointer items-center gap-2 py-1"
            >
              <Checkbox
                checked={waitForSetupCommands}
                onChange={handleWaitForSetupCommandsChange}
                ariaLabel={t('settings.openchamber.worktrees.setup.waitForCommandsAria')}
              />
              <span className={cn(
                'typography-ui-label font-normal',
                waitForSetupCommands ? 'text-foreground' : 'text-foreground/60'
              )}>
                {t('settings.openchamber.worktrees.setup.waitForCommands')}
              </span>
            </label>
          </div>
        )}
      </ProjectSettingsSubsection>
      ) : null}

      <ProjectSettingsSubsection
        title={t('settings.openchamber.worktrees.list.title')}
        titleAccessory={listTooltip}
      >
        {isLoadingWorktrees ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.list.loading')}</p>
        ) : availableWorktrees.length === 0 ? (
          <p className="typography-meta text-muted-foreground/70">
            {t('settings.openchamber.worktrees.list.empty')}
          </p>
        ) : (
          // The settings panel keeps its narrow control column; the full-page
          // Worktrees surface lets rows use the whole content width.
          <div className={cn('space-y-1', sections === 'all' && PROJECT_SETTINGS_CONTROL_WIDTH)}>
            {availableWorktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="group flex w-full items-center gap-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="typography-meta min-w-0 truncate text-foreground">
                      {worktree.label || worktree.branch || t('settings.openchamber.worktrees.list.detachedHead')}
                    </p>
                  </div>
                  <p className="typography-micro truncate text-muted-foreground/60">
                    {formatPathForDisplay(worktree.path, homeDirectory)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteWorktree(worktree)}
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                  aria-label={t('settings.openchamber.worktrees.list.deleteWorktreeAria', { name: worktree.branch || worktree.label || worktree.path })}
                >
                  <Icon name="delete-bin" className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ProjectSettingsSubsection>
    </>
  );
};
