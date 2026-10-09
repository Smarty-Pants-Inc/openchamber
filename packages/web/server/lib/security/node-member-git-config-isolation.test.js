import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { gitEnvForCaller, isolatedMemberGitEnv, runAsMember } from './node-member-execution.js';

/** Real Git with an owner's global config and server env that name helper programs. In Node mode a member-initiated
 *  Git child must not run any of them; the owner's own Git (Node mode, outside a member request, or no Node) keeps
 *  them all. Each helper touches its marker. The env comes from gitEnvForCaller, as the server's Git spawns do. */
const roots = [];
const savedNodeId = process.env.SMARTY_CODE_NODE_ID;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedNodeId === undefined) delete process.env.SMARTY_CODE_NODE_ID; else process.env.SMARTY_CODE_NODE_ID = savedNodeId;
});

const fixture = (caller, { gitconfig = () => '', env: extraEnv = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'node-git-isolation-')), repo = join(root, 'repo');
  roots.push(root);
  const marker = name => join(root, `${name}-ran`);
  const helper = (name) => {
    const file = join(root, `${name}.sh`);
    writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\ncat >/dev/null 2>&1\nexit 1\n`); chmodSync(file, 0o755);
    return file;
  };
  writeFileSync(join(root, '.gitconfig'), `[user]\n\tname = Owner\n\temail = owner@example.test\n${gitconfig(helper)}`);
  const serverEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    ...Object.fromEntries(Object.entries(extraEnv).map(([key, name]) => [key, helper(name)])) };
  if (caller === 'no Node') delete process.env.SMARTY_CODE_NODE_ID; else process.env.SMARTY_CODE_NODE_ID = 'fixture-node';
  const env = caller === 'Node member' ? runAsMember(() => gitEnvForCaller(serverEnv)) : gitEnvForCaller(serverEnv);
  const git = (...args) => { try { return execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' }).toString(); } catch { return null; } };
  mkdirSync(repo); git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), '1\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'a.txt'), '2\n');
  return { root, repo, env, git, ran: name => existsSync(marker(name)) };
};
const modes = [['Node member', false], ['Node owner (no member request)', true], ['no Node', true]];

for (const [who, runs] of modes) {
  const nodeId = who;
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

  it(`${who}: a global LFS-style filter ${runs ? 'runs' : 'does not run'} on add and checkout`, () => {
    const { repo, git, ran } = fixture(nodeId, { gitconfig: helper => `[filter "lfs"]\n\tclean = ${helper('clean')}\n`
      + `\tsmudge = ${helper('smudge')}\n\trequired = false\n` });
    writeFileSync(join(repo, '.gitattributes'), '*.bin filter=lfs\n'); writeFileSync(join(repo, 'a.bin'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'lfs'); rmSync(join(repo, 'a.bin')); git('checkout', '--', 'a.bin');
    expect([ran('clean'), ran('smudge')]).toEqual([runs, runs]);
  });
}

/** A member can make a directory that is a bare repository (HEAD, objects, refs, config) with any config, which Git
 *  would discover implicitly from inside it. safe.bareRepository=explicit stops that for member Git only. */
for (const [who, opens] of modes) {
  it(`${who}: Git ${opens ? 'opens' : 'refuses'} a member-made bare repository found implicitly`, () => {
    const { root, env, ran } = fixture(who);
    const bare = join(root, 'member-dir');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } });
    const helper = join(root, 'bare-gpg.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${join(root, 'bare-gpg-ran')}'\nexit 1\n`); chmodSync(helper, 0o755);
    execFileSync('git', ['config', '-f', join(bare, 'config'), 'gpg.program', helper]);
    let opened = true;
    try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: bare, env, stdio: 'pipe' }); } catch { opened = false; }
    expect(opened).toBe(opens);
    expect(ran('bare-gpg')).toBe(false);
  });
}

it('Node member: commits keep the owner identity (data only), and inherited GIT_CONFIG_* and GIT_CONFIG_PARAMETERS are dropped', () => {
  const { git, env } = fixture('Node member');
  expect(git('commit', '-q', '-am', 'member')).not.toBeNull();
  expect(git('log', '-1', '--format=%an <%ae>').trim()).toBe('Owner <owner@example.test>');
  const inherited = { GIT_CONFIG_PARAMETERS: "'core.pager'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external',
    GIT_CONFIG_VALUE_0: '/x', GIT_SSH_COMMAND: 'x', GIT_SSH: 'x', GIT_ASKPASS: 'x', SSH_ASKPASS: 'x', GIT_PROXY_COMMAND: 'x',
    HOME: env.HOME, PATH: env.PATH };
  const isolated = isolatedMemberGitEnv(inherited);
  expect(inherited.GIT_SSH).toBe('x'); // a new object; the server env is not changed
  expect(Object.keys(isolated).filter(key => /^(GIT_CONFIG_PARAMETERS|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND)$/.test(key)))
    .toEqual([]);
  expect(Object.entries(isolated).filter(([key, value]) => key.startsWith('GIT_CONFIG_KEY_') && value === 'diff.external'))
    .toEqual([]);
  expect([isolated.GIT_CONFIG_NOSYSTEM, isolated.GIT_CONFIG_GLOBAL]).toEqual(['1', '/dev/null']);
});
