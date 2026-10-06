/**
 * VS Code Git API implementation
 * Uses bridge messages to communicate with the extension host
 */

import { sendBridgeMessage } from './bridge';
import type {
  GitAPI,
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GeneratedPullRequestDescription,
  GitWorktreeInfo,
  GitWorktreeBootstrapStatus,
  CreateGitWorktreePayload,
  GitWorktreeValidationResult,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitLogResponse,
  GitLogOptions,
  GitCommitFilesResponse,
  CommitFileDiffResponse,
  GitIdentitySummary,
  GitIdentityProfile,
  GitRemote,
} from '@openchamber/ui/lib/api/types';

const requestWorktreeBootstrapStatus = (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  return sendBridgeMessage<GitWorktreeBootstrapStatus>('api:git/worktrees/bootstrap-status', { directory });
};

type GitIdentityStoreState = {
  profiles: GitIdentityProfile[];
};

type GitIdentityStoreApi = {
  getState: () => GitIdentityStoreState;
  setState: (
    nextState: GitIdentityStoreState | ((state: GitIdentityStoreState) => GitIdentityStoreState),
    replace?: boolean
  ) => void;
};

const getGitIdentityStore = (): GitIdentityStoreApi | undefined => (
  window as Window & {
    __zustand_git_identities_store__?: GitIdentityStoreApi;
  }
).__zustand_git_identities_store__;

export const createVSCodeGitAPI = (): GitAPI => ({
  checkIsGitRepository: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/check', { directory });
  },

  getGitStatus: async (directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus> => {
    return sendBridgeMessage<GitStatus>('api:git/status', { directory, mode: options?.mode });
  },

  getGitDiff: async (directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> => {
    return sendBridgeMessage<GitDiffResponse>('api:git/diff', {
      directory,
      path: options.path,
      staged: options.staged,
      contextLines: options.contextLines,
    });
  },

  getGitFileDiff: async (directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> => {
    return sendBridgeMessage<GitFileDiffResponse>('api:git/file-diff', {
      directory,
      path: options.path,
      staged: options.staged,
    });
  },









  isLinkedWorktree: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/worktree-type', { directory });
  },

  getGitBranches: async (directory: string): Promise<GitBranch> => {
    return sendBridgeMessage<GitBranch>('api:git/branches', { directory, method: 'GET' });
  },

  getGitUnpushedBranchCounts: async (directory: string, branches: string[]) => {
    return sendBridgeMessage('api:git/branch-push-status', { directory, branches });
  },





  generatePullRequestDescription: async (
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription> => {
    return sendBridgeMessage<GeneratedPullRequestDescription>('api:git/pr-description', {
      directory,
      base: payload.base,
      head: payload.head,
      context: payload.context,
      zenModel: payload.zenModel,
      providerId: payload.providerId,
      modelId: payload.modelId,
    });
  },

  listGitWorktrees: async (directory: string): Promise<GitWorktreeInfo[]> => {
    return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
  },

  validateGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
    return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
      directory,
      ...(payload || {}),
    });
  },

  getGitWorktreeBootstrapStatus: async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
    return requestWorktreeBootstrapStatus(directory);
  },

  previewGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
    return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees/preview', {
      directory,
      method: 'POST',
      ...(payload || {}),
    });
  },

  createGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
    return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
      directory,
      method: 'POST',
      ...(payload || {}),
    });
  },

  deleteGitWorktree: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
      directory,
      method: 'DELETE',
      body: {
        directory: payload.directory,
        deleteLocalBranch: payload.deleteLocalBranch === true,
      },
    });
  },





  listGitStashes: async (directory: string) => sendBridgeMessage('api:git/stashes', { directory }),
  countGitStashFiles: async (directory: string, refs: string[]) => sendBridgeMessage('api:git/stashes/file-counts', { directory, refs }),




  getGitLog: async (directory: string, options?: GitLogOptions): Promise<GitLogResponse> => {
    return sendBridgeMessage<GitLogResponse>('api:git/log', {
      directory,
      maxCount: options?.maxCount,
      from: options?.from,
      to: options?.to,
      file: options?.file,
      all: options?.all,
    });
  },

  getCommitFiles: async (directory: string, hash: string): Promise<GitCommitFilesResponse> => {
    return sendBridgeMessage<GitCommitFilesResponse>('api:git/commit-files', {
      directory,
      hash,
    });
  },

  getCommitFileDiff: async (directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse> => {
    return sendBridgeMessage<CommitFileDiffResponse>('api:git/commit-file-diff', {
      directory,
      hash,
      path: filePath,
      binary: isBinary,
    });
  },

  getCurrentGitIdentity: async (directory: string): Promise<GitIdentitySummary | null> => {
    return sendBridgeMessage<GitIdentitySummary | null>('api:git/identity', {
      directory,
      method: 'GET',
    });
  },


  // Git identity profile management is backed by the webview store in VS Code.
  getGitIdentities: async (): Promise<GitIdentityProfile[]> => {
    return getGitIdentityStore()?.getState().profiles ?? [];
  },




  getRemotes: async (directory: string): Promise<GitRemote[]> => {
    return sendBridgeMessage<GitRemote[]>('api:git/remotes', { directory });
  },













  getConflictDetails: async (directory: string) => {
    return sendBridgeMessage<{
      statusPorcelain: string;
      unmergedFiles: string[];
      diff: string;
      headInfo: string;
      operation: 'merge' | 'rebase';
    }>('api:git/conflict-details', { directory });
  },

  validateWorktreeDirectory: async (directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }> => {
    return sendBridgeMessage<{
      valid: boolean;
      insideWorktreeRoot: boolean;
      resolvedWorktreeRoot: string | null;
      resolvedCwd: string | null;
    }>('api:git/validate-directory', { directory, worktreeRoot });
  },

  canonicalizeWorktreeState: async (directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }> => {
    return sendBridgeMessage<{
      worktreeRoot: string | null;
      cwd: string | null;
      branch: string | null;
      headState: 'branch' | 'detached' | 'unborn';
      worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
      legacy: boolean;
      degraded: boolean;
      attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
    }>('api:git/canonicalize-worktree-state', { directory });
  },

  worktree: {
    list: async (directory: string): Promise<GitWorktreeInfo[]> => {
      return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
    },
    validate: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
      return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
        directory,
        ...(payload || {}),
      });
    },
    bootstrapStatus: async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
      return requestWorktreeBootstrapStatus(directory);
    },
    preview: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
      return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees/preview', {
        directory,
        method: 'POST',
        ...(payload || {}),
      });
    },
    create: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
      return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
        directory,
        method: 'POST',
        ...(payload || {}),
      });
    },
    remove: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
      return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
        directory,
        method: 'DELETE',
        body: {
          directory: payload.directory,
          deleteLocalBranch: payload.deleteLocalBranch === true,
        },
      });
    },
  },
});
