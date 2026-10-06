import type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GetGitRangeDiffOptions,
  GetGitRangeFilesOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GitUnpushedBranchCounts,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationResult,
  GitStashEntry,
  GitLogOptions,
  GitLogResponse,
  GitCommitFilesResponse,
  CommitFileDiffResponse,
  GitIdentityProfile,
  GitIdentitySummary,
  MergeConflictDetails,
} from './api/types';
import { normalizePath } from './pathNormalization';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { getRuntimeKey } from './runtime-switch';
import { subscribeGitStatusInvalidations } from './gitStatusInvalidation';

const API_BASE = '/api/git';
const GIT_STATUS_CACHE_TTL_MS = 1200;
const GIT_REPO_CHECK_CACHE_TTL_MS = 5000;
const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
const gitStatusCacheVersions = new Map<string, number>();
const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
const gitRepoInFlight = new Map<string, Promise<boolean>>();

const normalizeDirectoryKey = (directory: string): string => directory.trim();
const getDirectoryCacheKey = (runtimeKey: string, directory: string): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory)]);
const getStatusCacheKey = (runtimeKey: string, directory: string, mode?: 'light'): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory), mode ?? 'full']);

const getStatusCacheVersion = (runtimeKey: string, directory: string): number =>
  gitStatusCacheVersions.get(getDirectoryCacheKey(runtimeKey, directory)) ?? 0;

const clearGitStatusCache = (runtimeKey: string, directory: string): void => {
  const key = getDirectoryCacheKey(runtimeKey, directory);
  gitStatusCacheVersions.set(key, getStatusCacheVersion(runtimeKey, directory) + 1);
  for (const mode of [undefined, 'light'] as const) {
    const statusKey = getStatusCacheKey(runtimeKey, directory, mode);
    gitStatusCache.delete(statusKey);
    gitStatusInFlight.delete(statusKey);
  }
};

subscribeGitStatusInvalidations((directory) => {
  clearGitStatusCache(getRuntimeKey(), directory);
});

function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const query: Record<string, string | number | boolean | undefined> = { ...params };
  if (directory) query.directory = directory;

  return getRuntimeUrlResolver().api(path, query);
}

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const key = getDirectoryCacheKey(getRuntimeKey(), directory);
  const now = Date.now();
  const cached = gitRepoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitRepoInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/check`, directory));
    if (!response.ok) {
      throw new Error(`Failed to check git repository: ${response.statusText}`);
    }
    const data = await response.json();
    const isGitRepository = Boolean(data.isGitRepository);
    gitRepoCache.set(key, {
      value: isGitRepository,
      expiresAt: Date.now() + GIT_REPO_CHECK_CACHE_TTL_MS,
    });
    return isGitRepository;
  })();

  gitRepoInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitRepoInFlight.get(key) === task) {
      gitRepoInFlight.delete(key);
    }
  }
}

export class GitDirectoriesUnsupportedError extends Error {
  constructor() {
    super('Nested git repository discovery is not supported by this runtime');
    this.name = 'GitDirectoriesUnsupportedError';
  }
}

export async function listGitDirectories(root: string): Promise<string[]> {
  const response = await runtimeFetch('/api/fs/git-dirs', { query: { path: root } });
  if (response.status === 501) {
    throw new GitDirectoriesUnsupportedError();
  }
  if (!response.ok) {
    throw new Error(`Failed to list git directories: ${response.statusText}`);
  }
  // SAFETY: the route is ours (`GET /api/fs/git-dirs`) and answers this exact
  // shape on every 2xx; a malformed body fails the array check below.
  const data = await response.json() as { repositories?: Array<{ path?: string | null }> };
  if (!Array.isArray(data?.repositories)) {
    throw new Error('Unexpected git directories response');
  }
  // The server joins paths with the platform separator; every other git
  // directory key in the UI is normalized, so match that here or a Windows
  // repository never equals its own selection or root prefix.
  return data.repositories
    .map((entry) => normalizePath(entry?.path ?? null))
    .filter((path): path is string => path !== null);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus> {
  const mode = options?.mode;
  const runtimeKey = getRuntimeKey();
  if (options?.fresh) {
    // A forced read must cross the transport cache boundary too. Advancing the
    // version also prevents an older in-flight response from repopulating it.
    clearGitStatusCache(runtimeKey, directory);
  }
  const key = getStatusCacheKey(runtimeKey, directory, mode);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitStatusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const cacheVersion = getStatusCacheVersion(runtimeKey, directory);
    const response = await runtimeFetch(buildUrl(`${API_BASE}/status`, directory, mode ? { mode } : undefined));
    if (!response.ok) {
      throw new Error(`Failed to get git status: ${response.statusText}`);
    }
    const payload = await response.json() as GitStatus;
    if (getStatusCacheVersion(runtimeKey, directory) === cacheVersion) {
      gitStatusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
    }
    return payload;
  })();

  gitStatusInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitStatusInFlight.get(key) === task) {
      gitStatusInFlight.delete(key);
    }
  }
}

export async function resolveGitPrimaryRoot(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/primary-root`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git primary root: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function resolveGitTopLevel(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/toplevel`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git toplevel: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> {
  const { path, staged, contextLines } = options;
  if (!path) {
    throw new Error('path is required to fetch git diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitRangeDiff(
  directory: string,
  options: GetGitRangeDiffOptions
): Promise<GitDiffResponse> {
  const { base, head, path, contextLines } = options;
  if (!base || !head) {
    throw new Error('base and head are required to fetch git range diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/range-diff`, directory, {
      base,
      head,
      path: path || undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git range diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitRangeFiles(
  directory: string,
  options: GetGitRangeFilesOptions
): Promise<import('./api/types').GitRangeFileEntry[]> {
  const { base, head } = options;
  if (!base || !head) {
    throw new Error('base and head are required to fetch git range files');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/range-files`, directory, { base, head })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git range files: ${response.statusText}`);
  }

  const payload = (await response.json()) as { files?: unknown };
  if (!Array.isArray(payload.files)) return [];
  return payload.files.filter((entry): entry is import('./api/types').GitRangeFileEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as { path?: unknown; status?: unknown };
    return typeof candidate.path === 'string' && typeof candidate.status === 'string';
  });
}

export async function getBranchBase(
  directory: string,
  branch: string
): Promise<import('./api/types').GitBranchBaseResponse> {
  if (!branch) {
    throw new Error('branch is required to get branch base');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/branch-base`, directory, { branch })
  );

  if (!response.ok) {
    throw new Error(`Failed to get branch base: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> {
  const { path, staged } = options;
  if (!path) {
    throw new Error('path is required to fetch git file diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/file-diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git file diff: ${response.statusText}`);
  }

  return response.json();
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktree-type`, directory));
  if (!response.ok) {
    throw new Error(`Failed to detect worktree type: ${response.statusText}`);
  }
  const data = await response.json();
  return Boolean(data.linked);
}

export async function getGitBranches(directory: string): Promise<GitBranch> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get branches: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitUnpushedBranchCounts(directory: string, branches: string[]): Promise<GitUnpushedBranchCounts> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branch-push-status`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branches }),
  });
  if (!response.ok) throw new Error(`Failed to get branch push status: ${response.statusText}`);
  return response.json();
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ title: string; body: string }> {
  const { base, head, context, zenModel, providerId, modelId } = payload;
  if (!base || !head) {
    throw new Error('base and head are required');
  }

  const requestBody: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string } = { base, head };
  if (context?.trim()) {
    requestBody.context = context.trim();
  }
  if (zenModel) {
    requestBody.zenModel = zenModel;
  }
  if (providerId) {
    requestBody.providerId = providerId;
  }
  if (modelId) {
    requestBody.modelId = modelId;
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/pr-description`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to generate PR description');
  }

  const data = await response.json().catch(() => null);
  const title = typeof data?.title === 'string' ? data.title : '';
  const body = typeof data?.body === 'string' ? data.body : '';
  if (!title && !body) {
    throw new Error('Malformed PR description response');
  }
  return { title, body };
}

export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list worktrees');
  }
  return response.json();
}

export async function validateGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/validate`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to validate worktree');
  }

  return response.json();
}

export async function getGitWorktreeBootstrapStatus(directory: string): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/bootstrap-status`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to get worktree bootstrap status');
  }
  return response.json();
}

export async function previewGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/preview`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to preview worktree');
  }

  return response.json();
}

export async function createGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create worktree');
  }

  return response.json();
}

export async function deleteGitWorktree(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }

  return response.json();
}

export async function listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list stashes');
  }
  return response.json();
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes/file-counts`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to count stash files');
  }
  return response.json();
}

export async function getGitLog(
  directory: string,
  options: GitLogOptions = {}
): Promise<GitLogResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/log`, directory, {
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
      all: options.all ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to get git log: ${errorBody.error || response.statusText}`);
  }
  return response.json();
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<GitCommitFilesResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-files`, directory, { hash })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit files: ${response.statusText}`);
  }
  return response.json();
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<CommitFileDiffResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-file-diff`, directory, {
      hash,
      path: filePath,
      binary: isBinary ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit file diff: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitIdentities(): Promise<GitIdentityProfile[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get git identities: ${response.statusText}`);
  }
  return response.json();
}

export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/current-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get current git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/has-local-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to check local identity: ${response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.hasLocalIdentity === true;
}

export async function getGlobalGitIdentity(): Promise<GitIdentitySummary | null> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/global-identity`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get global git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || (!data.userName && !data.userEmail)) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remote-url`, directory, { remote }));
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.url ?? null;
}

export async function getRemotes(directory: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get remotes: ${response.statusText}`);
  }
  return response.json();
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get conflict details: ${response.statusText}`);
  }
  return response.json();
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/validate-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, worktreeRoot }),
  });
  if (!response.ok) {
    throw new Error(`Failed to validate worktree directory: ${response.statusText}`);
  }
  return response.json();
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/canonicalize-worktree-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(`Failed to canonicalize worktree state: ${response.statusText}`);
  }
  return response.json();
}
