import * as gitApiHttp from '@openchamber/ui/lib/gitApiHttp';
import type {
  GitAPI,
  GitLogOptions,
} from '@openchamber/ui/lib/api/types';

export const createWebGitAPI = (): GitAPI => ({
  checkIsGitRepository: gitApiHttp.checkIsGitRepository,
  getGitStatus: gitApiHttp.getGitStatus,
  getGitDiff: gitApiHttp.getGitDiff,
  getGitFileDiff: gitApiHttp.getGitFileDiff,
  getGitRangeDiff: gitApiHttp.getGitRangeDiff,
  getGitRangeFiles: gitApiHttp.getGitRangeFiles,
  getBranchBase: gitApiHttp.getBranchBase,
  isLinkedWorktree: gitApiHttp.isLinkedWorktree,
  getGitBranches: gitApiHttp.getGitBranches,
  getGitUnpushedBranchCounts: gitApiHttp.getGitUnpushedBranchCounts,
  generatePullRequestDescription: gitApiHttp.generatePullRequestDescription,
  listGitWorktrees: gitApiHttp.listGitWorktrees,
  // Worktree create/validate/preview/remove are not served to a browser (openchamber#554 round 6).
  validateWorktreeDirectory: gitApiHttp.validateWorktreeDirectory,
  canonicalizeWorktreeState: gitApiHttp.canonicalizeWorktreeState,
  listGitStashes: gitApiHttp.listGitStashes,
  countGitStashFiles: gitApiHttp.countGitStashFiles,
  getGitLog(directory: string, options?: GitLogOptions) {
    return gitApiHttp.getGitLog(directory, options);
  },
  getCommitFiles: gitApiHttp.getCommitFiles,
  getCurrentGitIdentity: gitApiHttp.getCurrentGitIdentity,
  hasLocalIdentity: gitApiHttp.hasLocalIdentity,
  getGitIdentities: gitApiHttp.getGitIdentities,
  getRemotes: gitApiHttp.getRemotes,
  getConflictDetails: gitApiHttp.getConflictDetails,
  worktree: {
    list: gitApiHttp.listGitWorktrees,
    bootstrapStatus: gitApiHttp.getGitWorktreeBootstrapStatus,
  },
});
