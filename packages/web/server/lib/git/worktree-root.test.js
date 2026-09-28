import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { managedWorktreeRoot } from './worktree-root.js';
import { previewWorktreeCreate } from './service.js';

// smarty-code#629: Code's "+ New" made worktrees in OpenCode's hidden data folder, outside every root its gateway admits
// (403, Send refused). OPENCHAMBER_WORKTREE_ROOT puts them at <root>/<repository folder>/ instead.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-worktree-root-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('managed worktree root', () => {
  it('is the stock data path unless OPENCHAMBER_WORKTREE_ROOT is set', () => {
    const base = { dataPath: '/d/opencode', projectID: 'p1', primaryWorktree: '/src/smarty-code' };
    expect(managedWorktreeRoot({ ...base, env: {} })).toBe('/d/opencode/worktree/p1');
    expect(managedWorktreeRoot({ ...base, env: { OPENCHAMBER_WORKTREE_ROOT: '  ' } })).toBe('/d/opencode/worktree/p1');
    expect(managedWorktreeRoot({ ...base, env: { OPENCHAMBER_WORKTREE_ROOT: '/h/.herdr/worktrees' } })).toBe('/h/.herdr/worktrees/smarty-code');
  });

  it('"+ New" (the create preview) places the worktree under the configured root, in the repository\'s folder', async () => {
    const repo = path.join(temp, 'my-repo'), root = path.join(temp, 'fleet-worktrees');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const before = process.env.OPENCHAMBER_WORKTREE_ROOT, dataBefore = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(temp, 'data'); process.env.OPENCHAMBER_WORKTREE_ROOT = root;
    try {
      const preview = await previewWorktreeCreate(repo, { worktreeName: 'lively-toucan' });
      expect(path.dirname(preview.path)).toBe(path.join(root, 'my-repo'));
      delete process.env.OPENCHAMBER_WORKTREE_ROOT;
      const stock = await previewWorktreeCreate(repo, { worktreeName: 'lively-toucan' });
      expect(stock.path.startsWith(path.join(temp, 'data', 'opencode', 'worktree'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.OPENCHAMBER_WORKTREE_ROOT; else process.env.OPENCHAMBER_WORKTREE_ROOT = before;
      if (dataBefore === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = dataBefore;
    }
  });
});
