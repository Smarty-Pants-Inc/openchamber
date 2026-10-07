import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { CommitFileEntry, GitStatus } from '@/lib/api/types';
import { useShallow } from 'zustand/react/shallow';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useIsGitRepo,
  useGitLoadingLog,
} from '@/stores/useGitStore';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getSessionWorktreeRepairActions } from '@/sync/session-worktree-contract';

import { GitHeader } from './git/GitHeader';
import { ChangesPanel, type ChangesGroupConfig } from './git/ChangesPanel';
import { GitEmptyState } from './git/GitEmptyState';
import { HistorySection } from './git/HistorySection';
import { deriveBaseBranch } from './git/baseBranch';
import { getFreshestPrStatusForBranch, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import type { GitRemote } from '@/lib/gitApi';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { cn } from '@/lib/utils';
import { getGitWorktreeBootstrapStatus } from '@/lib/gitApi';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';

// The Git view is read-only: working-tree status, per-file diffs and the
// commit history/graph. It offers no git writes (commit, push, pull, fetch,
// checkout, branch, stash, merge, rebase, reset, discard, identity): the served
// OpenChamber server does not expose those routes.

type GitLogDialogMode = 'history' | 'graph';
type HistoryBranchDivider = {
  insertBeforeIndex: number;
  branchName: string;
  direction: 'up' | 'down';
} | null;

const GIT_DIFF_PRIORITY_PREFETCH_LIMIT = 40;
const GIT_DIFF_PRIORITY_BASELINE_LIMIT = 20;

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

type GitViewProps = {
  isActive: boolean;
};

export const GitView: React.FC<GitViewProps> = ({ isActive }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const [worktreeBootstrapSnapshot, setWorktreeBootstrapSnapshot] = React.useState<{
    directory: string;
    status: 'pending' | 'ready' | 'failed' | null;
  } | null>(null);
  const [postBootstrapRefresh, setPostBootstrapRefresh] = React.useState<{
    directory: string;
    status: 'refreshing' | 'failed';
  } | null>(null);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
  const setDraftBootstrapPendingDirectory = useSessionUIStore((s) => s.setDraftBootstrapPendingDirectory);
  const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
  const availableWorktrees = useSessionUIStore((s) => s.availableWorktrees);
  const normalizedCurrentDirectory = normalizePath(currentDirectory);
  const inferredWorktreeMetadata = React.useMemo(() => {
    if (!normalizedCurrentDirectory) {
      return undefined;
    }

    const fromAvailable = availableWorktrees.find(
      (metadata) => normalizePath(metadata.path) === normalizedCurrentDirectory
    );
    if (fromAvailable) {
      return fromAvailable;
    }

    for (const metadata of worktreeMap.values()) {
      if (normalizePath(metadata.path) === normalizedCurrentDirectory) {
        return metadata;
      }
    }

    return undefined;
  }, [availableWorktrees, normalizedCurrentDirectory, worktreeMap]);
  const storeWorktreeMetadata = React.useMemo(() => {
    if (currentSessionId) {
      return worktreeMap.get(currentSessionId) ?? inferredWorktreeMetadata;
    }

    if (newSessionDraft?.open) {
      return inferredWorktreeMetadata;
    }

    return undefined;
  }, [currentSessionId, inferredWorktreeMetadata, newSessionDraft?.open, worktreeMap]);

  // The root the view is anchored to (session/worktree context stays keyed on
  // it). When the root is not itself a repository and the user picked a nested
  // one, `gitDirectory` is the effective repository all git data and actions
  // operate on. The hook owns probing, discovery, auto-select, and
  // stale-selection recovery; data fetching below keys off its result.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(
    currentDirectory ?? null,
    { enabled: isActive },
  );
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);

  // Authoritative session↔worktree attachment for repair action display
  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const repairActions = worktreeAttachment ? getSessionWorktreeRepairActions(worktreeAttachment) : [];

  // When an authoritative attachment exists, derive worktree-related fields from it
  // rather than from the live detected worktree metadata.
  const authoritativeProjectRoot = worktreeAttachment && !worktreeAttachment.degraded && !worktreeAttachment.legacy
    ? worktreeAttachment.worktreeRoot ?? undefined
    : undefined;

  const worktreeMetadata = useDetectedWorktreeMetadata(currentDirectory, storeWorktreeMetadata, status?.current ?? undefined);
  const branches = useGitBranches(gitDirectory ?? null);
  const log = useGitLog(gitDirectory ?? null);
  const isLogLoading = useGitLoadingLog(gitDirectory ?? null);
  const {
    setActiveDirectory,
    ensureAll,
    fetchStatus,
    fetchLog,
    setLogMaxCount,
    prefetchDiffs,
    clearDiffCache,
    ensureNestedRepos,
    selectNestedRepo,
  } = useGitStore(useShallow((state) => ({
    setActiveDirectory: state.setActiveDirectory,
    ensureAll: state.ensureAll,
    fetchStatus: state.fetchStatus,
    fetchLog: state.fetchLog,
    setLogMaxCount: state.setLogMaxCount,
    prefetchDiffs: state.prefetchDiffs,
    clearDiffCache: state.clearDiffCache,
    ensureNestedRepos: state.ensureNestedRepos,
    selectNestedRepo: state.selectNestedRepo,
  })));
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextDiff = useUIStore((state) => state.openContextDiff);
  const openContextSurface = useUIStore((state) => state.openContextSurface);

  const prStatusBranch = status?.current ?? null;
  const prChipStatus = useGitHubPrStatusStore((state) => {
    if (!gitDirectory || !prStatusBranch) {
      return null;
    }
    return getFreshestPrStatusForBranch(state.entries, gitDirectory, prStatusBranch);
  });
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) {
      setWorktreeBootstrapSnapshot(null);
      return;
    }

    const bootstrapDirectory = normalizePath(currentDirectory) ?? currentDirectory;
    setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: null });

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const next = await getGitWorktreeBootstrapStatus(currentDirectory);
        if (cancelled) {
          return;
        }
        setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: next.status });
        if (next.status === 'pending') {
          timeoutId = window.setTimeout(() => {
            void poll();
          }, 500);
        }
      } catch {
        if (!cancelled) {
          setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: null });
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isActive, currentDirectory]);

  const normalizedDraftBootstrapPendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
  const isDraftBootstrapPendingForCurrentDirectory = Boolean(
    currentDirectory && normalizedDraftBootstrapPendingDirectory && normalizedDraftBootstrapPendingDirectory === normalizePath(currentDirectory)
  );
  const sharedWorktreeBootstrapPending = useWorktreeBootstrapPending(currentDirectory ?? null);
  const normalizedCurrentBootstrapDirectory = normalizePath(currentDirectory);
  const observedWorktreeBootstrapStatus = worktreeBootstrapSnapshot?.directory === normalizedCurrentBootstrapDirectory
    ? worktreeBootstrapSnapshot.status
    : null;
  const isPendingWorktreeSetup = Boolean(
    currentDirectory
      && (
        sharedWorktreeBootstrapPending
        || observedWorktreeBootstrapStatus === 'pending'
        || (isDraftBootstrapPendingForCurrentDirectory && newSessionDraft?.pendingWorktreeRequestId)
      )
  );
  const isPostBootstrapRefreshForCurrentDirectory = Boolean(
    normalizedCurrentBootstrapDirectory
      && postBootstrapRefresh?.directory === normalizedCurrentBootstrapDirectory
  );

  React.useEffect(() => {
    if (!normalizedCurrentBootstrapDirectory) return;

    if (observedWorktreeBootstrapStatus === 'failed') {
      setDraftBootstrapPendingDirectory(null);
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory ? null : current
      ));
      return;
    }

    if (isPendingWorktreeSetup) {
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory && current.status === 'refreshing'
          ? current
          : { directory: normalizedCurrentBootstrapDirectory, status: 'refreshing' }
      ));
      return;
    }

    if (
      postBootstrapRefresh?.directory !== normalizedCurrentBootstrapDirectory
      || postBootstrapRefresh.status !== 'refreshing'
      || !gitDirectory
      || !git
    ) {
      return;
    }

    let cancelled = false;
    void fetchStatus(gitDirectory, git, {
      force: true,
      silent: true,
      throwOnError: true,
    }).then(() => {
      if (cancelled) return;
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory ? null : current
      ));
    }).catch(() => {
      if (cancelled) return;
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory
          ? { ...current, status: 'failed' }
          : current
      ));
    });

    return () => {
      cancelled = true;
    };
  }, [fetchStatus, git, gitDirectory, isPendingWorktreeSetup, normalizedCurrentBootstrapDirectory, observedWorktreeBootstrapStatus, postBootstrapRefresh, setDraftBootstrapPendingDirectory]);

  const shouldHideGitState = isPendingWorktreeSetup || isPostBootstrapRefreshForCurrentDirectory;
  const postBootstrapRefreshFailed = isPostBootstrapRefreshForCurrentDirectory
    && postBootstrapRefresh?.status === 'failed';

  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);

  React.useEffect(() => {
    const projectRoot = authoritativeProjectRoot || worktreeMetadata?.projectDirectory;
    if (!projectRoot) {
      setRootBranchHint(null);
      return;
    }

    let cancelled = false;
    void getRootBranch(projectRoot)
      .then((branch) => {
        if (cancelled) return;
        const normalized = branch.trim();
        setRootBranchHint(normalized && normalized !== 'HEAD' ? normalized : null);
      })
      .catch(() => {
        if (!cancelled) {
          setRootBranchHint(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authoritativeProjectRoot, worktreeMetadata?.projectDirectory]);

  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [logMaxCountLocal, setLogMaxCountLocal] = React.useState<number>(25);
  const [expandedCommitHashes, setExpandedCommitHashes] = React.useState<Set<string>>(new Set());
  const [commitFilesMap, setCommitFilesMap] = React.useState<Map<string, CommitFileEntry[]>>(new Map());
  const [loadingCommitHashes, setLoadingCommitHashes] = React.useState<Set<string>>(new Set());
  const commitFilesMapRef = React.useRef(commitFilesMap);
  const loadingCommitHashesRef = React.useRef(loadingCommitHashes);
  const [historyBranchDivider, setHistoryBranchDivider] = React.useState<HistoryBranchDivider>(null);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [gitLogDialogMode, setGitLogDialogMode] = React.useState<GitLogDialogMode | null>(null);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [graphLog, setGraphLog] = React.useState<import('@/lib/api/types').GitLogResponse | null>(null);
  const [graphLogLoading, setGraphLogLoading] = React.useState(false);
  const [graphLogMaxCount, setGraphLogMaxCount] = React.useState(100);
  const [graphLogRefreshToken, setGraphLogRefreshToken] = React.useState(0);

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success(t('gitView.toast.commitHashCopied'));
        return;
      }
      toast.error(t('gitView.toast.copyFailed'));
    });
  }, [t]);

  const handleToggleCommit = React.useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    commitFilesMapRef.current = commitFilesMap;
  }, [commitFilesMap]);

  React.useEffect(() => {
    loadingCommitHashesRef.current = loadingCommitHashes;
  }, [loadingCommitHashes]);

  React.useEffect(() => {
    if (!gitDirectory || !git) return;

    // Find hashes that are expanded but not yet loaded or loading
    const hashesToLoad = Array.from(expandedCommitHashes).filter(
      (hash) => !commitFilesMapRef.current.has(hash) && !loadingCommitHashesRef.current.has(hash)
    );

    if (hashesToLoad.length === 0) return;

    let cancelled = false;

    setLoadingCommitHashes((prev) => {
      const next = new Set(prev);
      for (const hash of hashesToLoad) {
        next.add(hash);
      }
      loadingCommitHashesRef.current = next;
      return next;
    });

    void Promise.all(
      hashesToLoad.map((hash) =>
        git
          .getCommitFiles(gitDirectory, hash)
          .then((response) => ({ hash, files: response.files }))
          .catch((error) => {
            console.error('Failed to fetch commit files:', error);
            return { hash, files: [] as CommitFileEntry[] };
          })
      )
    ).then((results) => {
      if (cancelled) return;
      setCommitFilesMap((prev) => {
        const next = new Map(prev);
        for (const { hash, files } of results) {
          next.set(hash, files);
        }
        commitFilesMapRef.current = next;
        return next;
      });
      setLoadingCommitHashes((prev) => {
        const next = new Set(prev);
        for (const { hash } of results) {
          next.delete(hash);
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    });

    return () => {
      cancelled = true;
      setLoadingCommitHashes((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const hash of hashesToLoad) {
          if (next.delete(hash)) {
            changed = true;
          }
        }
        if (!changed) {
          return prev;
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    };
  }, [expandedCommitHashes, gitDirectory, git]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!gitDirectory || !git?.getRemoteUrl || isGitRepo !== true) {
      setRemoteUrl(null);
      return;
    }
    let cancelled = false;
    git
      .getRemoteUrl(gitDirectory)
      .then((url) => { if (!cancelled) setRemoteUrl(url); })
      .catch(() => { if (!cancelled) setRemoteUrl(null); });
    return () => { cancelled = true; };
  }, [isActive, gitDirectory, git, isGitRepo]);

  const refreshRemotes = React.useCallback(async () => {
    if (!gitDirectory || !git?.getRemotes || isGitRepo !== true) {
      setRemotes([]);
      return;
    }
    try {
      const remoteList = await git.getRemotes(gitDirectory);
      if (mountedRef.current) {
        setRemotes(remoteList);
      }
    } catch {
      if (mountedRef.current) {
        setRemotes([]);
      }
    }
  }, [gitDirectory, git, isGitRepo]);

  React.useEffect(() => {
    if (!isActive) return;
    void refreshRemotes();
  }, [isActive, refreshRemotes]);

  React.useEffect(() => {
    if (!isActive) return;
    if (currentDirectory && gitDirectory) {
      setActiveDirectory(currentDirectory);
      void ensureAll(gitDirectory, git);
    }
  }, [isActive, currentDirectory, gitDirectory, setActiveDirectory, ensureAll, git]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!gitDirectory) {
      return;
    }

    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(gitDirectory)) {
        return;
      }
      if (hint.paths?.length) {
        clearDiffCache(gitDirectory, hint.paths);
      }
      void fetchStatus(gitDirectory, git, { silent: true });
    });
  }, [isActive, clearDiffCache, gitDirectory, fetchStatus, git]);

  const changeEntries = React.useMemo(() => {
    if (!status) return [];
    const files = status.files ?? [];
    // GitStatus.files is already unique by `path` per the server contract;
    // a defensive dedup pass would only mask real upstream bugs.
    return [...files].sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries]
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries]
  );

  React.useEffect(() => {
    if (!gitDirectory || changeEntries.length === 0) {
      return;
    }

    const orderedPaths: string[] = [];
    const seen = new Set<string>();

    const pushPath = (path: string) => {
      if (!path || seen.has(path)) {
        return;
      }
      seen.add(path);
      orderedPaths.push(path);
    };

    stagedChangeEntries.forEach((entry) => pushPath(entry.path));
    visibleChangePaths.forEach(pushPath);
    changeEntries.slice(0, GIT_DIFF_PRIORITY_BASELINE_LIMIT).forEach((entry) => pushPath(entry.path));

    if (orderedPaths.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(gitDirectory, git, orderedPaths, { maxFiles: GIT_DIFF_PRIORITY_PREFETCH_LIMIT });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [changeEntries, gitDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);

  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) {
      return remotes;
    }

    const inferredNames = new Set<string>();
    const tracking = status?.tracking?.trim();
    if (tracking && tracking.includes('/')) {
      inferredNames.add(tracking.split('/')[0]);
    }

    for (const branchName of remoteBranches) {
      const slashIndex = branchName.indexOf('/');
      if (slashIndex > 0) {
        inferredNames.add(branchName.slice(0, slashIndex));
      }
    }

    if (inferredNames.size === 0 && remoteUrl) {
      inferredNames.add('origin');
    }

    return Array.from(inferredNames).map((name) => ({
      name,
      fetchUrl: remoteUrl ?? '',
      pushUrl: remoteUrl ?? '',
    }));
  }, [remotes, remoteBranches, remoteUrl, status?.tracking]);

  const currentBranch = status?.current ?? null;

  // The repository's own default branch, so a repo whose default is neither
  // main, master nor develop stops being compared against a branch that does
  // not exist.
  const defaultBranch = React.useMemo(() => {
    const trackingRemote = status?.tracking?.trim().split('/')[0];
    return (trackingRemote && branches?.defaultBranches?.[trackingRemote])
      ?? branches?.defaultBranches?.origin;
  }, [branches, status?.tracking]);

  const baseBranch = React.useMemo(() => deriveBaseBranch({
    remoteNames: new Set(effectiveRemotes.map((remote) => remote.name)),
    localBranches,
    worktreeCreatedFromBranch: worktreeMetadata?.createdFromBranch,
    rootBranchHint,
    defaultBranch,
    headBranch: currentBranch,
  }), [
    currentBranch,
    defaultBranch,
    effectiveRemotes,
    localBranches,
    rootBranchHint,
    worktreeMetadata?.createdFromBranch,
  ]);

  React.useEffect(() => {
    if (!gitDirectory || !git || !log?.all?.length || !currentBranch || !baseBranch || currentBranch === baseBranch) {
      setHistoryBranchDivider(null);
      return;
    }

    let cancelled = false;

    const resolveBranchDivider = async () => {
      try {
        const branchOnlyLog = await git.getGitLog(gitDirectory, {
          from: baseBranch,
          to: 'HEAD',
          maxCount: logMaxCountLocal,
        });

        if (cancelled) {
          return;
        }

        const branchHashes = new Set(
          (branchOnlyLog?.all ?? [])
            .map((entry) => entry.hash)
            .filter((hash) => typeof hash === 'string' && hash.length > 0)
        );

        if (branchHashes.size === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        const insertBeforeIndex = log.all.findIndex((entry) => !branchHashes.has(entry.hash));
        if (insertBeforeIndex === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        if (insertBeforeIndex === -1) {
          setHistoryBranchDivider({
            insertBeforeIndex: log.all.length,
            branchName: currentBranch,
            direction: 'up',
          });
          return;
        }

        setHistoryBranchDivider({
          insertBeforeIndex,
          branchName: currentBranch,
          direction: 'up',
        });
      } catch {
        if (!cancelled) {
          setHistoryBranchDivider(null);
        }
      }
    };

    void resolveBranchDivider();

    return () => {
      cancelled = true;
    };
  }, [baseBranch, currentBranch, gitDirectory, git, log, logMaxCountLocal]);

  // Clear graph log when directory changes
  React.useEffect(() => {
    setGraphLog(null);
  }, [gitDirectory]);

  React.useEffect(() => {
    if (gitLogDialogMode !== 'graph' || !gitDirectory) {
      if (gitLogDialogMode !== 'graph') setGraphLog(null);
      return;
    }
    let cancelled = false;
    setGraphLogLoading(true);
    git.getGitLog(gitDirectory, { maxCount: graphLogMaxCount, all: true })
      .then((result) => {
        if (!cancelled) setGraphLog(result);
      })
      .catch((err) => {
        console.error('Failed to fetch graph log:', err);
      })
      .finally(() => {
        if (!cancelled) setGraphLogLoading(false);
      });
    return () => { cancelled = true; };
  }, [gitLogDialogMode, gitDirectory, graphLogMaxCount, graphLogRefreshToken, git]);

  // Context-panel tabs are keyed by the project root, not by the repository
  // being diffed: the diff surface resolves the selected nested repository on
  // its own, so opening the tab under `gitDirectory` would park it under a key
  // the panel never displays.
  const handleViewChangeDiff = React.useCallback((path: string, staged: boolean) => {
    if (currentDirectory && !isMobile) {
      openContextDiff(currentDirectory, path, staged);
      return;
    }
    navigateToDiff(path, staged);
  }, [currentDirectory, isMobile, navigateToDiff, openContextDiff]);

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
        onViewDiff: (path) => handleViewChangeDiff(path, true),
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: t('gitView.changes.title'),
        entries: unstagedChangeEntries,
        onViewDiff: (path) => handleViewChangeDiff(path, false),
      });
    }

    return groups;
  }, [handleViewChangeDiff, stagedChangeEntries, t, unstagedChangeEntries]);

  const handleLogMaxCountChange = React.useCallback(
    (count: number) => {
      setLogMaxCountLocal(count);
      if (gitDirectory) {
        setLogMaxCount(gitDirectory, count);
        fetchLog(gitDirectory, git, count);
      }
    },
    [gitDirectory, fetchLog, git, setLogMaxCount]
  );

  const handleGraphLogMaxCountChange = React.useCallback((count: number) => {
    setGraphLogMaxCount(count);
  }, []);

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          {t('gitView.empty.selectSessionOrDirectory')}
        </p>
      </div>
    );
  }

  if (shouldHideGitState) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        {!postBootstrapRefreshFailed ? (
          <Icon name="loader-4" className="mb-3 size-6 animate-spin text-muted-foreground" />
        ) : null}
        <p className="typography-ui-label font-semibold text-foreground">
          {postBootstrapRefreshFailed
            ? t('gitView.toast.refreshRepositoryFailed')
            : t('gitView.empty.worktreeSetupInProgress')}
        </p>
        {!postBootstrapRefreshFailed ? (
          <p className="typography-meta mt-1 text-muted-foreground">
            {t('gitView.empty.worktreeSetupDescription')}
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              if (!normalizedCurrentBootstrapDirectory) return;
              setPostBootstrapRefresh({
                directory: normalizedCurrentBootstrapDirectory,
                status: 'refreshing',
              });
            }}
          >
            {t('gitView.empty.retryDiscovery')}
          </Button>
        )}
      </div>
    );
  }

  if (isGitRepo === null || (isGitRepo === true && !status)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('gitView.loading.checkingRepository')}</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    // Nested repository discovery states (discovering, failed, unsupported,
    // none found, or settling on the auto-selected repository).
    return (
      <NestedRepoResolutionStates
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          if (currentDirectory) {
            void ensureNestedRepos(currentDirectory, { force: true });
          }
        }}
        emptyStateFooter={
          repairActions.includes('open-without-worktree-features') ? (
            <p className="typography-meta mt-2 text-muted-foreground">
              {t('gitView.empty.worktreeFeaturesUnavailable')}
            </p>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden')}>
      <GitHeader
        status={status}
        isWorktreeMode={!!worktreeMetadata}
        onOpenHistory={() => setGitLogDialogMode('history')}
        onOpenGraph={() => setGitLogDialogMode('graph')}
        pullRequest={prChipStatus?.pr ?? null}
        prChecks={prChipStatus?.checks ?? null}
        onOpenPullRequest={
          gitDirectory ? () => openContextSurface(gitDirectory, 'pr') : undefined
        }
        repositoryOptions={
          gitDirectory !== currentDirectory && Array.isArray(nestedRepos) ? nestedRepos : undefined
        }
        selectedRepository={gitDirectory !== currentDirectory ? gitDirectory : null}
        onSelectRepository={
          gitDirectory !== currentDirectory && currentDirectory
            ? (repository) => selectNestedRepo(currentDirectory, repository)
            : undefined
        }
        repositoryRoot={gitDirectory !== currentDirectory ? currentDirectory : undefined}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollableOverlay
          as={ScrollShadow}
          outerClassName="h-full min-h-0"
          className={cn('px-4', 'pt-1 pb-4')}
          disableHorizontal
          preventOverscroll
        >
          <div className="flex h-full min-h-0 flex-col gap-3">
            {(changeEntries?.length ?? 0) > 0 ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChangesPanel
                  groups={changeGroups}
                  diffStats={status?.diffStats}
                  onVisiblePathsChange={setVisibleChangePaths}
                  headerBackgroundClassName="bg-background"
                />
              </div>
            ) : (
              <GitEmptyState />
            )}
          </div>
        </ScrollableOverlay>
      </div>

      <Dialog open={gitLogDialogMode !== null} onOpenChange={(open) => { if (!open) setGitLogDialogMode(null); }}>
        <DialogContent className="max-w-5xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>
                {gitLogDialogMode === 'graph' ? t('gitView.graph.title') : t('gitView.history.title')}
              </DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-6 h-7 shrink-0 gap-1.5 px-2"
                onClick={() => {
                  if (gitLogDialogMode === 'graph') {
                    setGraphLogRefreshToken((token) => token + 1);
                    return;
                  }
                  if (!gitDirectory) return;
                  void fetchLog(gitDirectory, git, logMaxCountLocal);
                }}
                disabled={gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading}
                title={t('gitView.history.refresh')}
                aria-label={t('gitView.history.refresh')}
              >
                <Icon
                  name="refresh"
                  className={cn(
                    'size-4',
                    (gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading) && 'animate-spin'
                  )}
                />
                {t('gitView.history.refresh')}
              </Button>
            </div>
            <DialogDescription>
              {t('gitView.history.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <HistorySection
              mode={gitLogDialogMode === 'graph' ? 'graph' : 'history'}
              log={gitLogDialogMode === 'graph' ? graphLog ?? log : log}
              isLogLoading={gitLogDialogMode === 'graph' ? graphLogLoading || isLogLoading : isLogLoading}
              logMaxCount={gitLogDialogMode === 'graph' ? graphLogMaxCount : logMaxCountLocal}
              onLogMaxCountChange={gitLogDialogMode === 'graph' ? handleGraphLogMaxCountChange : handleLogMaxCountChange}
              expandedCommitHashes={expandedCommitHashes}
              onToggleCommit={handleToggleCommit}
              commitFilesMap={commitFilesMap}
              loadingCommitHashes={loadingCommitHashes}
              onCopyHash={handleCopyCommitHash}
              directory={gitDirectory ?? undefined}
              showHeader={false}
              contentMaxHeightClassName="h-full max-h-none"
              branchDivider={gitLogDialogMode === 'graph' ? null : historyBranchDivider}
            />
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};
