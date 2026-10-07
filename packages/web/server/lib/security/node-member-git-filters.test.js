import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableGitHooksInNodeMode } from './node-member-execution.js';

/** The owner's global Git config defines filter drivers (as git-lfs does); a member writes `.gitattributes` that
 *  selects them and stages or checks out a file. Each driver touches its marker if Git runs it. */
const driversRun = (nodeId) => {
  const root = mkdtempSync(join(tmpdir(), 'node-git-filters-')), repo = join(root, 'repo');
  try {
    const marker = name => join(root, `${name}-ran`);
    const driver = (name) => {
      const file = join(root, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\ncat\n`); chmodSync(file, 0o755);
      return file;
    };
    writeFileSync(join(root, '.gitconfig'), `[filter "lfs-like"]\n\tclean = ${driver('clean')}\n\tsmudge = ${driver('smudge')}\n`
      + `[filter "dotted.name"]\n\tclean = ${driver('dotted')}\n`);
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
    if (nodeId) env.SMARTY_CODE_NODE_ID = nodeId;
    disableGitHooksInNodeMode(env);
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
    mkdirSync(repo); git('init', '-q'); git('config', 'user.name', 'f'); git('config', 'user.email', 'f@example.test');
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=lfs-like\n*.md filter=dotted.name\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.md'), 'b\n');
    git('add', '.'); git('commit', '-q', '-m', 'member files');
    rmSync(join(repo, 'a.txt')); git('checkout', '--', 'a.txt');
    return ['clean', 'smudge', 'dotted'].filter(name => existsSync(marker(name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
};

it('Node mode: configured filter drivers do not run for member-selected attributes', () => {
  expect(driversRun('fixture-node')).toEqual([]);
});

it('owner (no Node): configured filter drivers still run', () => {
  expect(driversRun(undefined)).toEqual(['clean', 'smudge', 'dotted']);
});
