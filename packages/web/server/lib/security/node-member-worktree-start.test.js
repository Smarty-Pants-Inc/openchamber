import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWorktree, getWorktreeBootstrapStatus } from '../git/service.js';

/** A worktree request carries a start command; the server runs it in a login shell as its own OS account. */
const createWithStartCommand = async (nodeId) => {
  const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, SMARTY_CODE_NODE_ID: process.env.SMARTY_CODE_NODE_ID };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-worktree-start-'));
  const marker = path.join(root, 'start-command-ran'), script = path.join(root, 'start.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  process.env.XDG_DATA_HOME = root;
  if (nodeId) process.env.SMARTY_CODE_NODE_ID = nodeId; else delete process.env.SMARTY_CODE_NODE_ID;
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const created = await createWorktree(repo, { mode: 'new', branchName: 'feature/start', worktreeName: 'start',
      returnAfterDirectoryCreated: true, startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` });
    await expect.poll(async () => (await getWorktreeBootstrapStatus(created.path)).phase, { timeout: 10_000 })
      .toBe('setup-ready');
    return fs.existsSync(marker);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

it('Node mode: a worktree start command does not run, and the worktree is still created', async () => {
  expect(await createWithStartCommand('fixture-node')).toBe(false);
}, 30_000);

it('owner (no Node): the worktree start command runs', async () => {
  expect(await createWithStartCommand(undefined)).toBe(true);
}, 30_000);
