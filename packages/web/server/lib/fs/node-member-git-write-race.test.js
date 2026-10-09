import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { expect, it, vi } from 'vitest';
import { runAsMember } from '../security/node-member-execution.js';
import { registerFsRoutes } from './routes.js';

const NODE = { PATH: process.env.PATH, SMARTY_CODE_NODE_ID: 'fixture-node' };
const GIT_REFUSAL = { error: "Changing Git metadata isn't available for members on this Node yet.", code: 'NODE_MEMBER_GIT_METADATA_REFUSED' };

/** Routes on a real tree. `hook(name, args)` runs before each fsPromises call, so a test can swap a path after the
 *  route has checked it (the race a concurrent checkout of a committed symbolic link can win). */
const onDisk = (env, hook = () => {}) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'node-git-race-')));
  const fsp = Object.fromEntries(['access', 'link', 'lstat', 'mkdir', 'open', 'readFile', 'readlink', 'realpath', 'rename',
    'rm', 'stat', 'unlink', 'writeFile'].map((name) => [name, (...args) => { hook(name, args); return fsPromises[name](...args); }]));
  const routes = new Map();
  const spawn = vi.fn((_command, args, options) => {
    hook('spawn', [args, options]);
    // What `git clone` does: create the destination (an existing empty directory is accepted) and write into it.
    mkdirSync(path.join(options.cwd, args.at(-1)), { recursive: true });
    writeFileSync(path.join(options.cwd, args.at(-1), 'HEAD'), 'ref: refs/heads/main\n');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  registerFsRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) }, {
    os: { homedir: () => root }, path, fsPromises: fsp, spawn, crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: p => path.resolve(root, p), resolveProjectDirectory: async () => ({ directory: root }),
    buildAugmentedPath: () => process.env.PATH, resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: path.join(root, '.config'), env,
  });
  const call = async (route, body, req = { body, query: body, headers: {} }) => {
    let statusCode = 200, payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; },
      setHeader() { return this; }, getHeader() {}, type() { return this; }, send(value) { payload = value; return this; } };
    await routes.get(`POST /api/fs/${route}`)(req, res);
    return { statusCode, body: payload };
  };
  return { root, call, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const upload = (filePath) => Object.assign(Readable.from([Buffer.from('#!/bin/sh\ntouch pwned\n')]),
  { query: { path: filePath, overwrite: 'true' }, headers: { 'content-type': 'application/octet-stream' }, body: {} });

/** P1 (TOCTOU): `repo/src` is an ordinary directory when the route checks it, and a link to `repo/.git/hooks` when
 *  the write happens. The write must not land in Git metadata. */
const races = [
  ['write', 'writeFile', { path: 'repo/src/pre-commit', content: '#!/bin/sh\ntouch pwned\n' }],
  ['upload', 'open', null, upload('repo/src/pre-commit')],
  ['mkdir', 'mkdir', { path: 'repo/src/pre-commit' }],
  ['delete', 'rm', { path: 'repo/src/x' }],
  ['rename', 'rename', { oldPath: 'repo/src/x', newPath: 'repo/src/pre-commit' }],
  ['clone', 'spawn', { remoteUrl: 'https://example.test/pre-commit.git', destinationPath: 'repo/src/' }],
];
for (const [route, trigger, body, req] of races) {
  it(`Node member ${route}: a directory swapped to a Git metadata link after the check is not written through`, async () => {
    let swapped = false;
    const { root, call, cleanup } = onDisk(NODE, (name) => {
      if (name !== trigger || swapped) return;
      swapped = true;
      renameSync(path.join(root, 'repo', 'src'), path.join(root, 'repo', 'moved'));
      symlinkSync(path.join(root, 'repo', '.git', 'hooks'), path.join(root, 'repo', 'src'));
    });
    try {
      for (const dir of ['src', '.git/hooks']) {
        mkdirSync(path.join(root, 'repo', dir), { recursive: true });
        writeFileSync(path.join(root, 'repo', dir, 'x'), dir);
      }
      await call(route, body, req).catch(() => null);
      expect(swapped).toBe(true);
      expect(readdirSync(path.join(root, 'repo', '.git', 'hooks'))).toEqual(['x']);
      expect(readFileSync(path.join(root, 'repo', '.git', 'hooks', 'x'), 'utf8')).toBe('.git/hooks');
    } finally { cleanup(); }
  });
}

it('Node member clone: a destination swapped to a Git metadata link after the existence check is not cloned into', async () => {
  let swapped = false;
  const { root, call, cleanup } = onDisk(NODE, (name) => {
    if (name !== 'spawn' || swapped) return;
    swapped = true;
    const destination = path.join(root, 'repo', 'src', 'app');
    if (existsSync(destination)) renameSync(destination, `${destination}-moved`);
    symlinkSync(path.join(root, 'repo', '.git', 'empty'), destination);
  });
  try {
    mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
    mkdirSync(path.join(root, 'repo', '.git', 'empty'), { recursive: true });
    await call('clone', { remoteUrl: 'https://example.test/app.git', destinationPath: 'repo/src/' }).catch(() => null);
    expect(swapped).toBe(true);
    expect(readdirSync(path.join(root, 'repo', '.git', 'empty'))).toEqual([]);
  } finally { cleanup(); }
});

/** P2 (alternate Git directory): a `gitdir:` file or a bare repository puts Git metadata at a path with no `.git`
 *  component. The guard resolves the Git directory as Git does. */
const withRepos = (env) => {
  const disk = onDisk(env);
  const git = (...args) => execFileSync('git', args, { cwd: disk.root, stdio: 'pipe' });
  git('init', '-q', '--separate-git-dir', path.join(disk.root, 'repo', 'meta'), path.join(disk.root, 'repo'));
  git('init', '-q', '--bare', path.join(disk.root, 'bare.git'));
  git('init', '-q', '--bare', path.join(disk.root, 'spaced ')); // A Git directory whose name ends in whitespace.
  return disk;
};
const alternates = [
  ['write', { path: 'repo/meta/hooks/pre-commit', content: '#!/bin/sh\n' }, 'repo/meta/hooks/pre-commit'],
  ['write', { path: 'repo/meta/config', content: '[core]\n\tfsmonitor = ./x\n' }, null],
  ['write', { path: 'bare.git/hooks/pre-commit', content: '#!/bin/sh\n' }, 'bare.git/hooks/pre-commit'],
  ['write', { path: 'spaced /hooks/pre-commit', content: '#!/bin/sh\n' }, 'spaced /hooks/pre-commit'],
  ['upload', null, 'repo/meta/hooks/post-checkout'],
  ['mkdir', { path: 'repo/meta/hooks/new' }, 'repo/meta/hooks/new'],
  ['delete', { path: 'repo/meta/HEAD' }, null],
  ['rename', { oldPath: 'repo/notes', newPath: 'repo/meta/hooks/pre-commit' }, 'repo/meta/hooks/pre-commit'],
  ['clone', { remoteUrl: 'https://example.test/x.git', destinationPath: 'repo/meta/hooks' }, 'repo/meta/hooks/hooks'],
];
for (const [route, body, created] of alternates) {
  it(`Node member ${route} into a Git directory without a .git component (${JSON.stringify(body ?? created)}) gets the refusal`, async () => {
    const { root, call, cleanup } = withRepos(NODE);
    try {
      writeFileSync(path.join(root, 'repo', 'notes'), 'notes');
      const configBefore = readFileSync(path.join(root, 'repo', 'meta', 'config'), 'utf8');
      const res = route === 'upload' ? await call(route, null, upload(created)) : await call(route, body);
      expect(res).toEqual({ statusCode: 403, body: GIT_REFUSAL });
      if (created && route !== 'upload') expect(existsSync(path.join(root, created))).toBe(false);
      if (route === 'upload') expect(existsSync(path.join(root, created))).toBe(false);
      expect(readFileSync(path.join(root, 'repo', 'meta', 'config'), 'utf8')).toBe(configBefore);
      expect(existsSync(path.join(root, 'repo', 'meta', 'HEAD'))).toBe(true);
    } finally { cleanup(); }
  });
}

it('Node member request (member Git env: safe.bareRepository=explicit) is still refused in a bare Git directory', async () => {
  const { root, call, cleanup } = withRepos(NODE);
  const before = process.env.SMARTY_CODE_NODE_ID;
  process.env.SMARTY_CODE_NODE_ID = NODE.SMARTY_CODE_NODE_ID; // memberInitiated() reads the process env.
  try {
    for (const target of ['bare.git/hooks/pre-commit', 'spaced /config', 'repo/meta/config']) {
      expect(await runAsMember(() => call('write', { path: target, content: 'x' }))).toEqual({ statusCode: 403, body: GIT_REFUSAL });
    }
    expect(existsSync(path.join(root, 'bare.git', 'hooks', 'pre-commit'))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.SMARTY_CODE_NODE_ID; else process.env.SMARTY_CODE_NODE_ID = before;
    cleanup();
  }
});

it('Node member mkdir that cannot create a level leaks no directory descriptor', async () => {
  const { root, call, cleanup } = onDisk(NODE);
  try {
    mkdirSync(path.join(root, 'locked'), { mode: 0o555 });
    const open = () => readdirSync('/proc/self/fd').length;
    const before = open();
    for (let i = 0; i < 5; i += 1) expect((await call('mkdir', { path: 'locked/a/b' })).statusCode).toBe(403);
    expect(open()).toBe(before);
  } finally { chmodSync(path.join(root, 'locked'), 0o755); cleanup(); }
});

it('Node member write into the worktree of a repository with a separate Git directory still works', async () => {
  const { root, call, cleanup } = withRepos(NODE);
  try {
    expect((await call('write', { path: 'repo/src/notes.md', content: 'hi' })).statusCode).toBe(200);
    expect(readFileSync(path.join(root, 'repo', 'src', 'notes.md'), 'utf8')).toBe('hi');
    expect((await call('mkdir', { path: 'repo/a/b/c' })).statusCode).toBe(200);
    expect((await call('rename', { oldPath: 'repo/src/notes.md', newPath: 'repo/a/b/c/n.md' })).statusCode).toBe(200);
    expect((await call('upload', null, upload('repo/a/b/up.sh'))).statusCode).toBe(200);
    expect(readFileSync(path.join(root, 'repo', 'a', 'b', 'up.sh'), 'utf8')).toContain('pwned');
    expect((await call('delete', { path: 'repo/a/b/c/n.md' })).statusCode).toBe(200);
    expect(existsSync(path.join(root, 'repo', 'a', 'b', 'c', 'n.md'))).toBe(false);
  } finally { cleanup(); }
});

it('owner (no Node) write into a separate Git directory is not refused by the Git guard', async () => {
  const { root, call, cleanup } = withRepos({ PATH: process.env.PATH });
  try {
    expect((await call('write', { path: 'repo/meta/description', content: 'owner' })).statusCode).toBe(200);
    expect(readFileSync(path.join(root, 'repo', 'meta', 'description'), 'utf8')).toBe('owner');
  } finally { cleanup(); }
});
