import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from '../opencode/env-runtime.js';
import { createOpenCodeLifecycleRuntime } from '../opencode/lifecycle.js';
import { disableGitHooksInNodeMode } from './node-member-execution.js';

/** The server's real order (index.js): the login-shell snapshot fills process.env at module load, main() then adds the
 *  Node-mode Git overrides, and every managed OpenCode launch and restart merges the cached snapshot with the live
 *  process.env. A fake `opencode` records the env it was really given; real Git then commits with that env. */
const launchEnvs = async (root, nodeId) => {
  const envDir = join(root, 'envs');
  mkdirSync(envDir);
  const fakeOpenCode = join(root, 'opencode');
  writeFileSync(fakeOpenCode, `#!/bin/sh\nenv -0 > '${envDir}'/"$$"\necho 'opencode server listening on http://127.0.0.1:1'\nexec sleep 30\n`);
  chmodSync(fakeOpenCode, 0o755);
  // The login shell already carries a Git config entry that points hooks into the worktree.
  const shellSnapshot = { PATH: process.env.PATH, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '.husky' };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_CONFIG_') || key === 'SMARTY_CODE_NODE_ID') delete process.env[key];
  }
  Object.assign(process.env, { HOME: root, OPENCODE_BINARY: fakeOpenCode }, nodeId ? { SMARTY_CODE_NODE_ID: nodeId } : {});

  const envState = { cachedLoginShellEnvSnapshot: shellSnapshot };
  const envRuntime = createOpenCodeEnvRuntime({ state: envState, normalizeDirectoryPath: value => value,
    readSettingsFromDiskMigrated: async () => ({}) });
  envRuntime.applyLoginShellEnvSnapshot(); // index.js module load
  disableGitHooksInNodeMode(process.env); // index.js main()

  const state = { openCodeWorkingDirectory: root, openCodeProcess: null, openCodePort: null, currentRestartPromise: null,
    isOpenCodeReady: false, isExternalOpenCode: false, isShuttingDown: false, expressApp: null, useWslForOpencode: false };
  const lifecycle = createOpenCodeLifecycleRuntime({
    state,
    env: { ENV_CONFIGURED_OPENCODE_PORT: 0, ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1', ENV_SKIP_OPENCODE_START: false },
    syncToHmrState: () => {}, syncFromHmrState: () => {}, getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: route => `http://127.0.0.1:1${route}`, waitForReady: async () => true, normalizeApiPrefix: () => '',
    applyOpencodeBinaryFromSettings: async () => null, ensureOpencodeCliEnv: () => {},
    ensureLocalOpenCodeServerPassword: async () => 'password',
    resolveManagedOpenCodeLaunchSpec: binary => ({ binary, args: [], wrapperType: null }),
    setOpenCodePort: () => {}, setDetectedOpenCodeApiPrefix: () => {}, setupProxy: () => {},
    ensureOpenCodeApiPrefix: () => {}, clearResolvedOpenCodeBinary: () => {},
    buildManagedOpenCodePath: () => process.env.PATH,
    getManagedOpenCodeShellEnvSnapshot: envRuntime.getLoginShellEnvSnapshot, // index.js wiring
  });
  state.openCodeProcess = await lifecycle.startOpenCode();
  try {
    await lifecycle.restartOpenCode('fixture-restart');
  } finally {
    await state.openCodeProcess?.close();
  }
  return readdirSync(envDir).map(file => Object.fromEntries(readFileSync(join(envDir, file), 'utf8').split('\0')
    .filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])));
};

/** A Git child of managed OpenCode commits in a husky-style repo where a member wrote the pre-commit file. */
const hookRuns = (root, env) => {
  const repo = mkdtempSync(join(root, 'repo-')), marker = join(repo, 'hook-ran');
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...env, HOME: repo, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe' });
  git('init', '-q'); git('config', 'core.hooksPath', '.husky');
  git('config', 'user.name', 'fixture'); git('config', 'user.email', 'f@example.test');
  mkdirSync(join(repo, '.husky'));
  writeFileSync(join(repo, '.husky', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(repo, '.husky', 'pre-commit'), 0o755);
  git('commit', '-q', '--allow-empty', '-m', 'agent commit');
  return existsSync(marker);
};

const withServerEnv = async (nodeId, check) => {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'node-managed-env-'));
  try {
    const envs = await launchEnvs(root, nodeId);
    expect(envs).toHaveLength(2); // the launch and the restart
    for (const env of envs) check(env, root);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
};

it('Node mode: managed OpenCode launch and restart get the Git hook and fsmonitor overrides over the shell snapshot',
  async () => {
    await withServerEnv('fixture-node', (env, root) => {
      expect(env.GIT_CONFIG_COUNT).toBe('3');
      expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(['core.hooksPath', '/dev/null']);
      expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['core.fsmonitor', 'false']);
      expect(hookRuns(root, env)).toBe(false);
    });
  }, 30000);

it('owner (no Node): managed OpenCode keeps the shell Git config and the repository hook runs', async () => {
  await withServerEnv(undefined, (env, root) => {
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(hookRuns(root, env)).toBe(true);
  });
}, 30000);
