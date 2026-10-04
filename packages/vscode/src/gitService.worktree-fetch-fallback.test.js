import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree } = await import('./gitService.ts?worktree-fetch-fallback-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const createRepositoryWithRemote = () => {
  const remote = createTempDir();
  const repository = createTempDir();
  runGit(remote, ['init', '--bare', '--initial-branch=main']);
  runGit(repository, ['init', '-b', 'next']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  runGit(repository, ['remote', 'add', 'origin', remote]);
  runGit(repository, ['push', 'origin', 'HEAD:main']);
  runGit(repository, ['fetch', 'origin']);
  return { repository };
};

// Include refs, config, FETCH_HEAD, index, objects and tracked files, not read timestamps.
const snapshotRepository = (repository) =>
  fs.readdirSync(repository, { recursive: true }).sort().map((entry) => {
    const file = path.join(repository, entry);
    const stat = fs.lstatSync(file);
    return {
      path: entry,
      mode: stat.mode,
      sha256: stat.isFile() ? new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex') : null,
    };
  });

const expectUnavailableCreation = async (repository, input, dataHome) => {
  const before = snapshotRepository(repository);
  const previousGitTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = path.join(dataHome, 'raw-git.trace');
  try {
    await expect(createWorktree(repository, input)).rejects.toThrow(/GIT_PROCESS_UNSUPPORTED.*unavailable/i);
  } finally {
    if (previousGitTrace === undefined) {
      delete process.env.GIT_TRACE;
    } else {
      process.env.GIT_TRACE = previousGitTrace;
    }
  }
  expect(snapshotRepository(repository)).toEqual(before);
  // Any native Git launch would write the trace; any destination would populate this root.
  expect(fs.readdirSync(dataHome)).toEqual([]);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code worktree create from a remote start ref', () => {
  it('rejects unavailable creation without fetching or changing the tracked local fallback', async () => {
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', '--set-upstream-to=origin/main', 'next']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      expect(runGit(repository, ['rev-parse', 'refs/remotes/origin/main']).trim())
        .toBe(runGit(repository, ['rev-parse', 'next']).trim());
      expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'next@{upstream}']).trim()).toBe('origin/main');
      expect(runGit(repository, ['remote', 'get-url', 'origin']).trim()).toBe('/nonexistent/openchamber-unreachable.git');
      expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('# Test\n');

      await expectUnavailableCreation(repository, {
        mode: 'new',
        branchName: 'openchamber/stale-ref-wt',
        worktreeName: 'stale-ref-wt',
        startRef: 'remotes/origin/main',
      }, process.env.XDG_DATA_HOME);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('rejects unavailable creation without fetching or restoring the missing remote start ref', async () => {
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      expect(() => runGit(repository, ['show-ref', '--verify', 'refs/remotes/origin/main'])).toThrow();
      expect(runGit(repository, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('next');
      expect(runGit(repository, ['config', '--get', 'user.email']).trim()).toBe('test@example.com');
      expect(runGit(repository, ['config', '--get', 'user.name']).trim()).toBe('Test');
      expect(runGit(repository, ['remote', 'get-url', 'origin']).trim()).toBe('/nonexistent/openchamber-unreachable.git');
      expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('# Test\n');

      await expectUnavailableCreation(repository, {
        mode: 'new',
        branchName: 'openchamber/never-fetched-wt',
        worktreeName: 'never-fetched-wt',
        startRef: 'remotes/origin/main',
      }, process.env.XDG_DATA_HOME);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);
});
