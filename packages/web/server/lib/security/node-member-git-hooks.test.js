import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableGitHooksInNodeMode } from './node-member-execution.js';

/** A husky-style repo: core.hooksPath points into the worktree, where a member can write a pre-commit file. */
const commitWithWorktreeHook = (nodeId) => {
  const root = mkdtempSync(join(tmpdir(), 'node-git-hooks-')), marker = join(root, 'hook-ran');
  try {
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'fixture', ...(nodeId ? { SMARTY_CODE_NODE_ID: nodeId } : {}) };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
    git('init', '-q'); git('config', 'core.hooksPath', '.husky'); git('config', 'user.email', 'f@example.test');
    mkdirSync(join(root, '.husky'));
    writeFileSync(join(root, '.husky', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(root, '.husky', 'pre-commit'), 0o755);
    expect(disableGitHooksInNodeMode(env)).toBe(Boolean(nodeId));
    git('commit', '-q', '--allow-empty', '-m', 'member commit');
    expect(git('config', 'user.name').toString().trim()).toBe('fixture'); // Existing GIT_CONFIG entries are kept.
    return existsSync(marker);
  } finally { rmSync(root, { recursive: true, force: true }); }
};

it('Node mode: a Git child runs no member-written hook', () => {
  expect(commitWithWorktreeHook('fixture-node')).toBe(false);
});

it('owner (no Node): the repository hook still runs', () => {
  expect(commitWithWorktreeHook(undefined)).toBe(true);
});
