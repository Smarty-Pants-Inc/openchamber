import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getDiff } from '../git/service.js';
import { disableGitHooksInNodeMode } from './node-member-execution.js';

/** The last source of a diff helper once system and global config are off: a repository's own .git/config (written by
 *  the owner). In Node mode the server's diff passes --no-ext-diff and --no-textconv, so neither runs. */
const helperRunsOnDiff = async (nodeId, localConfig) => {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'node-git-diff-flags-')), repo = join(root, 'repo'), marker = join(root, 'ran');
  try {
    const helper = join(root, 'helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat \"$1\" 2>/dev/null\n`); chmodSync(helper, 0o755);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    mkdirSync(repo); git('init', '-q'); git('config', 'user.name', 'f'); git('config', 'user.email', 'f@example.test');
    for (const [key, value] of localConfig(helper)) git('config', key, value);
    writeFileSync(join(repo, '.gitattributes'), '*.t diff=tx\n'); writeFileSync(join(repo, 'a.t'), '1\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'a.t'), '2\n');
    Object.assign(process.env, { HOME: root, GIT_CONFIG_NOSYSTEM: '1' });
    if (nodeId) process.env.SMARTY_CODE_NODE_ID = nodeId; else delete process.env.SMARTY_CODE_NODE_ID;
    disableGitHooksInNodeMode(process.env);
    await getDiff(repo, { path: 'a.t' }).catch(() => null);
    return existsSync(marker);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
};
const external = helper => [['diff.external', helper]];
const textconv = helper => [['diff.tx.textconv', helper]];

it('Node mode: a repository diff.external does not run on the server diff', async () => {
  expect(await helperRunsOnDiff('fixture-node', external)).toBe(false);
});
it('Node mode: a repository textconv does not run on the server diff', async () => {
  expect(await helperRunsOnDiff('fixture-node', textconv)).toBe(false);
});
it('owner (no Node): repository diff.external and textconv still run on the server diff', async () => {
  expect([await helperRunsOnDiff(undefined, external), await helperRunsOnDiff(undefined, textconv)]).toEqual([true, true]);
});
