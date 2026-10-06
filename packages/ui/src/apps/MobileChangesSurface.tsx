import React from 'react';
import { Icon } from '@/components/icon/Icon';

import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesPanel, type ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import type { GitStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import {
  useGitStore,
  useGitStatus,
  useIsGitRepo,
  useGitLoadingStatus,
} from '@/stores/useGitStore';
import { NestedRepoResolutionStates } from '@/components/views/git/NestedRepoResolutionStates';
import { NestedRepoPicker } from '@/components/views/git/NestedRepoPicker';
import { getRuntimeKey } from '@/lib/runtime-switch';

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

const diffCacheKey = (path: string, staged: boolean): string => staged ? `${path}\u0000staged` : path;

type MobileChangesSurfaceProps = {
  /** When provided, the list header gets a close X that calls this. */
  onClose?: () => void;
  /**
   * When set (and non-null), the surface opens directly into the per-file diff view for this
   * relative path. Updating it (incl. setting it to a different path while open) routes the
   * surface to that diff. Setting it back to null leaves the user on the current internal route.
   */
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = ({ onClose, initialDiffPath, initialDiffStaged = false }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const rootDirectory = normalizePath(useEffectiveDirectory() ?? null);
  // When the root is not itself a repository, changes come from the resolved
  // nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(rootDirectory || null);
  const currentDirectory = gitDirectory ?? rootDirectory;
  const status = useGitStatus(currentDirectory || null);
  const isGitRepo = useIsGitRepo(currentDirectory || null);
  const isLoadingStatus = useGitLoadingStatus(currentDirectory || null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);
  const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const getDiff = useGitStore((state) => state.getDiff);
  const setDiff = useGitStore((state) => state.setDiff);

  const [route, setRoute] = React.useState<{ type: 'list' } | { type: 'diff'; path: string; staged: boolean }>(
    () => (initialDiffPath ? { type: 'diff', path: initialDiffPath, staged: initialDiffStaged } : { type: 'list' }),
  );

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session.
  React.useEffect(() => {
    if (!initialDiffPath) return;
    setRoute((current) => (
      current.type === 'diff' && current.path === initialDiffPath && current.staged === initialDiffStaged
        ? current
        : { type: 'diff', path: initialDiffPath, staged: initialDiffStaged }
    ));
  }, [initialDiffPath, initialDiffStaged]);
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);

  const changeEntries = React.useMemo(() => {
    const files = status?.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      unique.set(file.path, file);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status?.files]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries],
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries],
  );

  const selectedDiff = useGitStore(React.useCallback((state) => {
    if (!currentDirectory || route.type !== 'diff') return null;
    return state.directories.get(currentDirectory)?.diffCache.get(diffCacheKey(route.path, route.staged)) ?? null;
  }, [currentDirectory, route]));

  const selectedFileEntry = React.useMemo(() => {
    if (route.type !== 'diff') return null;
    return changeEntries.find((entry) => entry.path === route.path) ?? null;
  }, [changeEntries, route]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    setActiveDirectory(currentDirectory);
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git, setActiveDirectory]);

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) return;
    const orderedPaths = Array.from(new Set([
      ...stagedChangeEntries.map((entry) => entry.path),
      ...visibleChangePaths,
      ...changeEntries.slice(0, 20).map((entry) => entry.path),
    ])).filter(Boolean);
    if (orderedPaths.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: 40 });
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [changeEntries, currentDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  React.useEffect(() => {
    if (route.type !== 'diff') {
      setDiffLoadError(null);
      return;
    }
    const cacheKey = diffCacheKey(route.path, route.staged);
    if (!currentDirectory || getDiff(currentDirectory, cacheKey)) {
      setDiffLoadError(null);
      return;
    }

    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    setDiffLoadError(null);
    void git.getGitFileDiff(currentDirectory, { path: route.path, staged: route.staged || undefined })
      .then((response) => {
        if (cancelled) return;
        setDiff(currentDirectory, cacheKey, {
          original: response.original ?? '',
          modified: response.modified ?? '',
          isBinary: response.isBinary,
        }, runtimeKey);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, diffRetryNonce, getDiff, git, route, setDiff]);

  const handleViewChangeDiff = React.useCallback((path: string, staged = false) => {
    setRoute({ type: 'diff', path, staged });
  }, []);

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
        onViewDiff: (path: string) => handleViewChangeDiff(path, true),
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: t('gitView.changes.title'),
        entries: unstagedChangeEntries,
        onViewDiff: (path: string) => handleViewChangeDiff(path, false),
      });
    }

    return groups;
  }, [handleViewChangeDiff, stagedChangeEntries, t, unstagedChangeEntries]);

  const renderListState = (state: React.ReactNode) => (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory || ''}
          </p>
        </div>
        {rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0 ? (
          <NestedRepoPicker
            repositories={nestedRepos}
            selectedRepository={gitDirectory ?? null}
            onSelectRepository={(repository) => {
              if (rootDirectory) selectNestedRepo(rootDirectory, repository);
            }}
            repositoryRoot={rootDirectory ?? undefined}
          />
        ) : null}
      </header>
      <div className="min-h-0 flex-1">{state}</div>
    </div>
  );

  if (!currentDirectory) {
    return renderListState(<MobileChangesState message={t('gitView.empty.selectSessionOrDirectory')} />);
  }

  // Non-repo root: surface nested-repository resolution while the operating
  // directory has not proven to be a repository (discovering, failed,
  // unsupported, none found, or settling on the auto-selected one).
  if (rootIsGitRepo === false && isGitRepo !== true) {
    return renderListState(
      <NestedRepoResolutionStates
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          if (rootDirectory) void ensureNestedRepos(rootDirectory, { force: true });
        }}
      />
    );
  }

  if (isLoadingStatus && isGitRepo === null) {
    return renderListState(<MobileChangesState loading message={t('gitView.loading.checkingRepository')} />);
  }

  if (route.type === 'diff') {
    return (
      <MobileDiffDetail
        path={route.path}
        diff={selectedDiff}
        fileExists={Boolean(selectedFileEntry)}
        error={diffLoadError}
        onBack={() => setRoute({ type: 'list' })}
        onRetry={() => setDiffRetryNonce((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory}
          </p>
        </div>
      </header>
      {changeEntries.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
            <ChangesPanel
              groups={changeGroups}
              diffStats={status?.diffStats}
              headerBackgroundClassName="bg-transparent"
              onVisiblePathsChange={setVisibleChangePaths}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MobileChangesState icon message={t('gitView.empty.cleanTitle')} description={t('mobile.changes.cleanDescription')} />
        </div>
      )}
    </div>
  );
};

const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

const MobileDiffDetail: React.FC<{
  path: string;
  diff: { original: string; modified: string; isBinary?: boolean } | null;
  fileExists: boolean;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}> = ({ path, diff, fileExists, error, onBack, onRetry }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/70 px-3 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="truncate typography-ui-header text-foreground">{path}</h2>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.missingTitle')} description={t('mobile.changes.diffDetail.missingDescription')} />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{t('mobile.changes.diffDetail.loadFailed')}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('diffView.actions.retry')}</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : diff.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : isImageFile(path) ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.imageUnavailable')} />
        ) : (
          <ScrollShadow
            className="h-full overflow-y-auto overflow-x-hidden p-3"
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              language={language}
              fileName={path}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
            />
          </ScrollShadow>
        )}
      </div>
    </div>
  );
};
