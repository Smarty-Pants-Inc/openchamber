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
const readGitConfig = (env, args) => {
  try {
    return execFileSync('git', ['config', '-z', ...args],
      { cwd: tmpdir(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\0').filter(Boolean);
  } catch {
    return [];
  }
};
const configuredAttributeDriverKeys = env => readGitConfig(env, ['--name-only', '--get-regexp', ATTRIBUTE_DRIVER_KEYS]);

/** Server env that names a program Git runs (or a source of config that can). Node mode removes them all. */
const EXECUTABLE_GIT_ENV = ['GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_PROXY_COMMAND', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG'];
/** Set, not removed: Git treats `:` as no editor and `cat` as no pager, so its fallbacks (core.editor, core.pager,
 *  VISUAL, EDITOR, PAGER) never run either. */
const NO_OP_GIT_ENV = { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_PAGER: 'cat' };

/** Node mode: every Git child of this server is member-initiated (they inherit process.env; pass the cached login-shell
 *  snapshot too, it is merged under process.env for managed OpenCode). Git reads no system or global config and no
 *  executable env (external diff, ssh, askpass, editors, pager, credential and gpg helpers, filters, uploadpack hooks),
 *  and the only GIT_CONFIG_* entries are these: hooks and fsmonitor off, credential helpers and askpass cleared, every
 *  attribute driver the owner's config defined set empty (defence in depth), and the owner's identity, which is data.
 *  The owner (non-Node) path is unchanged. ponytail: read once at startup; a repository's own .git/config still
 *  applies (members cannot write .git). */
export const disableGitHooksInNodeMode = (env = process.env, shellSnapshot = null) => {
  if (!memberExecutionRefused(env)) return false;
  const isolated = key => EXECUTABLE_GIT_ENV.includes(key) || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key);
  for (const key of Object.keys(shellSnapshot ?? {})) if (isolated(key)) delete shellSnapshot[key];
  const identity = ['user.name', 'user.email'].flatMap(key => readGitConfig(env, ['--get', key]).slice(0, 1)
    .map(value => [key, value.replace(/\n$/, '')]));
  const overrides = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['credential.helper', ''],
    ['core.askPass', ''], ...[...new Set(configuredAttributeDriverKeys(env))].map(key => [key, '']), ...identity];
  for (const key of Object.keys(env)) {
    if (isolated(key)) delete env[key];
  }
  Object.assign(env, NO_OP_GIT_ENV, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(overrides.length);
  return true;
};

/** Node mode: diff, log and show (also `stash show`) never run an external diff or textconv helper, even one a
 *  repository's own config names. Other Git arguments are returned unchanged. */
const DIFF_COMMANDS = new Set(['diff', 'log', 'show']);
export const withoutDiffHelpersInNodeMode = (args, env = process.env) => {
  if (!memberExecutionRefused(env) || !Array.isArray(args)) return args;
  const at = args[0] === 'stash' && args[1] === 'show' ? 2 : DIFF_COMMANDS.has(args[0]) ? 1 : 0;
  return at ? [...args.slice(0, at), '--no-ext-diff', '--no-textconv', ...args.slice(at)] : args;
};

/** Git runs repository hooks and config commands (core.hooksPath, core.fsmonitor, filters) as this account, so in
 *  Node mode members may not write Git metadata: any path with a `.git` component (a `.git` file names a gitdir). */
export const GIT_METADATA_REFUSED = "Changing Git metadata isn't available for members on this Node yet.";
export const isGitMetadataPath = (value) => typeof value === 'string'
  && value.split(/[\\/]+/).some(part => part.toLowerCase() === '.git');
