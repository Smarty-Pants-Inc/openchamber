import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Every export is auto-stubbed from the real module, so the adapter shape is
// checked without any request leaving the test.
vi.mock('@openchamber/ui/lib/gitApiHttp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

const here = path.dirname(fileURLToPath(import.meta.url));
const uiLib = path.resolve(here, '../../../ui/src/lib');

// The git write routes the served server no longer registers (hostdel slice,
// smarty-code#1398). Method + path, as the server registered them.
const REMOVED_GIT_ROUTES = [
  'POST /identities', 'PUT /identities/', 'DELETE /identities/', 'POST /set-identity', 'GET /discover-credentials',
  'POST /integrate/', 'POST /revert', 'POST /stage', 'POST /unstage', 'POST /apply-hunk', 'POST /pull', 'POST /push',
  'POST /stash', 'POST /stash/apply', 'POST /stash/pop', 'POST /stash/drop', 'POST /fetch', 'POST /rebase',
  'POST /rebase/abort', 'POST /rebase/continue', 'POST /merge', 'POST /merge/abort', 'POST /merge/continue',
  'POST /commit', 'POST /branches', 'POST /checkout', 'POST /checkout-commit', 'POST /cherry-pick',
  'POST /revert-commit', 'POST /reset-to-commit', 'DELETE /remotes', 'DELETE /branches', 'DELETE /remote-branches',
  'PUT /branches/rename',
];

// Reads every `/api/git/...` request the shared HTTP adapter can make, with its
// method (a request with no explicit method is a GET).
const collectAdapterGitRequests = (): string[] => {
  const source = readFileSync(path.join(uiLib, 'gitApiHttp.ts'), 'utf8');
  const requests: string[] = [];
  const call = /runtimeFetch\(\s*(?:buildUrl\(\s*)?`\$\{API_BASE\}(\/[^`$]*)/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const rest = source.slice(match.index, match.index + 400);
    const end = rest.indexOf(');');
    const method = /method:\s*'([A-Z]+)'/.exec(rest.slice(0, end))?.[1] ?? 'GET';
    requests.push(`${method} ${match[1]}`);
  }
  return requests;
};

describe('createWebGitAPI', () => {
  it('offers no git write operation', async () => {
    const { createWebGitAPI } = await import('./git');
    const api = createWebGitAPI();
    for (const name of ['stageGitFiles', 'unstageGitFiles', 'revertGitFile', 'createGitCommit', 'gitPush', 'gitPull',
      'gitFetch', 'checkoutBranch', 'createBranch', 'renameBranch', 'deleteGitBranch', 'deleteRemoteBranch',
      'removeRemote', 'stashGitChanges', 'merge', 'rebase', 'resetToCommit', 'cherryPick', 'setGitIdentity',
      'createGitIdentity', 'deleteGitIdentity']) {
      expect(api).not.toHaveProperty(name);
    }
  });

  it('keeps the read operations the Git view uses', async () => {
    const { createWebGitAPI } = await import('./git');
    const api = createWebGitAPI();
    for (const name of ['getGitStatus', 'getGitDiff', 'getGitFileDiff', 'getGitBranches', 'getGitLog', 'getCommitFiles', 'getRemotes']) {
      expect(typeof api[name as keyof typeof api]).toBe('function');
    }
  });
});

describe('shared git HTTP adapter', () => {
  it('requests no removed git write route', () => {
    const requests = collectAdapterGitRequests();
    expect(requests).toContain('GET /status');
    const removed = requests.filter((request) => REMOVED_GIT_ROUTES.some((route) => (
      route.endsWith('/') ? request.startsWith(route) : request === route
    )));
    expect(removed).toEqual([]);
  });

  it('has no other caller of /api/git/integrate', () => {
    const source = readFileSync(path.join(uiLib, 'gitApiHttp.ts'), 'utf8');
    expect(source).not.toContain('/api/git/integrate');
  });
});
