import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Node members share the server's OS account, so a member-controlled shell could read the gateway credential
 * (smarty-code#1356). Until member execution is isolated, Node mode refuses terminals and commands before any
 * child exists. SMARTY_CODE_NODE_ID is the same switch that makes human auth require Node membership
 * (ui-auth/human-member.js), so every signed-in human in that mode is a member; other modes are unchanged.
 */
export const MEMBER_EXECUTION_REFUSED = "Terminal and commands aren't available for members on this Node yet.";
export const MEMBER_EXECUTION_REFUSED_CODE = 'NODE_MEMBER_EXECUTION_REFUSED';

export const memberExecutionRefused = (env = process.env) => env?.SMARTY_CODE_NODE_ID !== undefined;

export const refuseMemberExecution = (res) =>
  res.status(403).json({ error: MEMBER_EXECUTION_REFUSED, code: MEMBER_EXECUTION_REFUSED_CODE });

/** The driver commands that member `.gitattributes` can select: filter (git-lfs and the like), diff textconv and
 *  external diff, and merge drivers, as defined in system, global and inherited GIT_CONFIG_* config. Read outside a
 *  repository; Git missing or no match means none. */
const ATTRIBUTE_DRIVER_KEYS = '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command)|merge\\..*\\.driver)$';
const configuredAttributeDriverKeys = (env) => {
  try {
    return execFileSync('git', ['config', '-z', '--name-only', '--get-regexp', ATTRIBUTE_DRIVER_KEYS],
      { cwd: tmpdir(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\0').filter(Boolean);
  } catch {
    return [];
  }
};

/** Node mode: every Git child of this server (they inherit process.env) runs with hooks and fsmonitor off, so an
 *  existing core.hooksPath into the worktree (husky) cannot run member-written files. Each configured attribute driver
 *  command is set empty: Git skips a filter (a `required` one fails), and diff and merge fail or leave a conflict;
 *  none runs. Command-line precedence.
 *  ponytail: drivers are read once at startup; one defined in a repository's own .git/config is not covered. */
export const disableGitHooksInNodeMode = (env = process.env) => {
  if (!memberExecutionRefused(env)) return false;
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const overrides = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'],
    ...[...new Set(configuredAttributeDriverKeys(env))].map(key => [key, ''])];
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${count + index}`] = key; env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(count + overrides.length);
  return true;
};

/** Git runs repository hooks and config commands (core.hooksPath, core.fsmonitor, filters) as this account, so in
 *  Node mode members may not write Git metadata: any path with a `.git` component (a `.git` file names a gitdir). */
export const GIT_METADATA_REFUSED = "Changing Git metadata isn't available for members on this Node yet.";
export const isGitMetadataPath = (value) => typeof value === 'string'
  && value.split(/[\\/]+/).some(part => part.toLowerCase() === '.git');
