import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedMemberGitEnv } from './node-member-execution.js';

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
    const serverEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
    const env = nodeId ? isolatedMemberGitEnv(serverEnv) : serverEnv; // a member's Git, or the owner's
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
    mkdirSync(repo); git('init', '-q'); git('config', 'user.name', 'f'); git('config', 'user.email', 'f@example.test');
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=lfs-like\n*.md filter=dotted.name\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.md'), 'b\n');
    git('add', '.'); git('commit', '-q', '-m', 'member files');
    rmSync(join(repo, 'a.txt')); git('checkout', '--', 'a.txt');
    return ['clean', 'smudge', 'dotted'].filter(name => existsSync(marker(name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
};

/** Diff and merge drivers are selected by `.gitattributes` the same way: textconv and external diff on `git diff`,
 *  a merge driver on a conflicting merge. A disabled driver fails the command instead of running. */
const diffMergeDriversRun = (nodeId) => {
  const root = mkdtempSync(join(tmpdir(), 'node-git-drivers-')), repo = join(root, 'repo');
  try {
    const marker = name => join(root, `${name}-ran`);
    const driver = (name) => {
      const file = join(root, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\ncat "$1" 2>/dev/null\nexit 0\n`); chmodSync(file, 0o755);
      return file;
    };
    writeFileSync(join(root, '.gitconfig'), `[diff "tx"]\n\ttextconv = ${driver('textconv')}\n`
      + `[diff "cx"]\n\tcommand = ${driver('command')}\n[merge "mx"]\n\tdriver = ${driver('merge')} %O %A %B\n`);
    const serverEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
    const env = nodeId ? isolatedMemberGitEnv(serverEnv) : serverEnv; // a member's Git, or the owner's
    const git = (...args) => { try { execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' }); } catch { /* a refused driver fails the command */ } };
    mkdirSync(repo); git('init', '-q', '-b', 'main'); git('config', 'user.name', 'f'); git('config', 'user.email', 'f@example.test');
    writeFileSync(join(repo, '.gitattributes'), '*.t diff=tx\n*.c diff=cx\n*.m merge=mx\n');
    for (const file of ['a.t', 'a.c', 'a.m']) writeFileSync(join(repo, file), '1\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'side'); writeFileSync(join(repo, 'a.m'), 'side\n'); git('commit', '-q', '-am', 'side');
    git('checkout', '-q', 'main'); writeFileSync(join(repo, 'a.m'), 'main\n'); git('commit', '-q', '-am', 'main');
    git('merge', '-q', 'side');
    writeFileSync(join(repo, 'a.t'), '2\n'); git('diff', '--', 'a.t');
    writeFileSync(join(repo, 'a.c'), '2\n'); git('diff', '--', 'a.c');
    return ['textconv', 'command', 'merge'].filter(name => existsSync(marker(name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
};

it('Node member: configured diff and merge drivers do not run for member-selected attributes', () => {
  expect(diffMergeDriversRun('fixture-node')).toEqual([]);
});

it('owner: configured diff and merge drivers still run', () => {
  expect(diffMergeDriversRun(undefined)).toEqual(['textconv', 'command', 'merge']);
});

it('Node member: configured filter drivers do not run for member-selected attributes', () => {
  expect(driversRun('fixture-node')).toEqual([]);
});

it('owner: configured filter drivers still run', () => {
  expect(driversRun(undefined)).toEqual(['clean', 'smudge', 'dotted']);
});
