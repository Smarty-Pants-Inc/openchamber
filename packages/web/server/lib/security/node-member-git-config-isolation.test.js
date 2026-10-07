import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { disableGitHooksInNodeMode } from './node-member-execution.js';

/** Real Git with an owner's global config and server env that name helper programs. In Node mode a member-initiated
 *  Git child must not run any of them; the owner (no Node) keeps them all. Each helper touches its marker. */
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = (nodeId, { gitconfig = () => '', env: extraEnv = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'node-git-isolation-')), repo = join(root, 'repo');
  roots.push(root);
  const marker = name => join(root, `${name}-ran`);
  const helper = (name) => {
    const file = join(root, `${name}.sh`);
    writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\ncat >/dev/null 2>&1\nexit 1\n`); chmodSync(file, 0o755);
    return file;
  };
  writeFileSync(join(root, '.gitconfig'), `[user]\n\tname = Owner\n\temail = owner@example.test\n${gitconfig(helper)}`);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    ...Object.fromEntries(Object.entries(extraEnv).map(([key, name]) => [key, helper(name)])) };
  if (nodeId) env.SMARTY_CODE_NODE_ID = nodeId;
  disableGitHooksInNodeMode(env);
  const git = (...args) => { try { return execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' }).toString(); } catch { return null; } };
  mkdirSync(repo); git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), '1\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'a.txt'), '2\n');
  return { root, repo, env, git, ran: name => existsSync(marker(name)) };
};
const modes = [['fixture-node', false], [undefined, true]];

for (const [nodeId, runs] of modes) {
  const who = nodeId ? 'Node mode' : 'owner (no Node)';
  it(`${who}: global diff.external ${runs ? 'runs' : 'does not run'} on git diff`, () => {
    const { git, ran } = fixture(nodeId, { gitconfig: helper => `[diff]\n\texternal = ${helper('external')}\n` });
    git('diff');
    expect(ran('external')).toBe(runs);
  });

  it(`${who}: GIT_EXTERNAL_DIFF in the server env ${runs ? 'runs' : 'does not run'} on git diff`, () => {
    const { git, ran } = fixture(nodeId, { env: { GIT_EXTERNAL_DIFF: 'env-external' } });
    git('diff');
    expect(ran('env-external')).toBe(runs);
  });

  it(`${who}: global gpg.program ${runs ? 'runs' : 'does not run'} on verify-commit of a signed commit`, () => {
    const { git, ran } = fixture(nodeId, { gitconfig: helper => `[gpg]\n\tprogram = ${helper('gpg')}\n` });
    const tree = git('rev-parse', 'HEAD^{tree}').trim();
    const signed = `tree ${tree}\nauthor A <a@example.test> 1 +0000\ncommitter A <a@example.test> 1 +0000\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n fixture\n -----END PGP SIGNATURE-----\n\nsigned\n';
    const file = join(tmpdir(), `signed-${process.pid}-${Date.now()}`);
    writeFileSync(file, signed);
    try { git('verify-commit', git('hash-object', '-t', 'commit', '-w', file).trim()); } finally { rmSync(file, { force: true }); }
    expect(ran('gpg')).toBe(runs);
  });

  it(`${who}: global credential.helper ${runs ? 'runs' : 'does not run'} when a fetch gets 401`, async () => {
    const { repo, env, ran } = fixture(nodeId, { gitconfig: helper => `[credential]\n\thelper = ${helper('credential')}\n` });
    const server = createServer((req, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await promisify(execFile)('git', ['fetch', `http://127.0.0.1:${server.address().port}/r.git`], { cwd: repo, env })
        .catch(() => null);
    } finally { server.close(); }
    expect(ran('credential')).toBe(runs);
  });
}

it('Node mode: commits keep the owner identity (data only), and inherited GIT_CONFIG_* and GIT_CONFIG_PARAMETERS are dropped', () => {
  const { git, env } = fixture('fixture-node');
  expect(git('commit', '-q', '-am', 'member')).not.toBeNull();
  expect(git('log', '-1', '--format=%an <%ae>').trim()).toBe('Owner <owner@example.test>');
  const inherited = { GIT_CONFIG_PARAMETERS: "'core.pager'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external',
    GIT_CONFIG_VALUE_0: '/x', GIT_SSH_COMMAND: 'x', GIT_SSH: 'x', GIT_ASKPASS: 'x', SSH_ASKPASS: 'x', GIT_PROXY_COMMAND: 'x',
    SMARTY_CODE_NODE_ID: 'fixture-node', HOME: env.HOME, PATH: env.PATH };
  disableGitHooksInNodeMode(inherited);
  expect(Object.keys(inherited).filter(key => /^(GIT_CONFIG_PARAMETERS|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND)$/.test(key)))
    .toEqual([]);
  expect(Object.entries(inherited).filter(([key, value]) => key.startsWith('GIT_CONFIG_KEY_') && value === 'diff.external'))
    .toEqual([]);
  expect([inherited.GIT_CONFIG_NOSYSTEM, inherited.GIT_CONFIG_GLOBAL]).toEqual(['1', '/dev/null']);
});
