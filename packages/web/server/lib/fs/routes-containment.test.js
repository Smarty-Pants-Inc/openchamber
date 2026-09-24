import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFsRoutes } from './routes.js';

// smarty-code#155 item 2: every creating (and moving or deleting) fs route must stay inside its canonical
// workspace. A symbolic link inside the project that points outside must never let a request reach outside.
const registry = () => {
  const routes = new Map();
  return { app: { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) },
    route: (p) => routes.get(`POST ${p}`) };
};
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; }, type() { return this; }, setHeader() {}, send() { return this; } });

describe('fs creating routes keep canonical workspace containment', () => {
  let root, project, outside, fs;
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain-')));
    project = path.join(root, 'project'); outside = path.join(root, 'outside');
    await fs.mkdir(project); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'victim.txt'), 'keep');
    await fs.writeFile(path.join(project, 'inside.txt'), 'mine');
    await fs.symlink(outside, path.join(project, 'link'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const routes = () => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: project }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'),
    });
    const call = async (name, body) => { const res = response(); await route(name)({ body, query: {}, get: () => null }, res); return res; };
    return call;
  };
  const exists = (target) => fs.lstat(target).then(() => true, () => false);

  it('refuses every escape through the symbolic link and leaves outside untouched', async () => {
    const call = routes();
    expect((await call('/api/fs/write', { path: path.join(project, 'link', 'new', 'file.txt'), content: 'x' })).statusCode).toBe(403);
    expect((await call('/api/fs/write', { path: path.join(project, 'link', 'victim.txt'), content: 'x' })).statusCode).toBe(403);
    expect((await call('/api/fs/mkdir', { path: path.join(project, 'link', 'made') })).statusCode).toBe(403);
    expect((await call('/api/fs/rename', { oldPath: path.join(project, 'inside.txt'), newPath: path.join(project, 'link', 'moved.txt') })).statusCode).toBe(403);
    expect((await call('/api/fs/rename', { oldPath: path.join(project, 'link', 'victim.txt'), newPath: path.join(project, 'stolen.txt') })).statusCode).toBe(403);
    expect((await call('/api/fs/delete', { path: path.join(project, 'link', 'victim.txt') })).statusCode).toBe(403);
    expect(await fs.readdir(outside)).toEqual(['victim.txt']);
    expect(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(project, 'inside.txt'), 'utf8')).toBe('mine');
  });

  it('keeps ordinary work inside the project, including removing the link itself', async () => {
    const call = routes();
    expect((await call('/api/fs/write', { path: path.join(project, 'a', 'b.txt'), content: 'ok' })).statusCode).toBe(200);
    expect((await call('/api/fs/mkdir', { path: path.join(project, 'c', 'd') })).statusCode).toBe(200);
    expect((await call('/api/fs/rename', { oldPath: path.join(project, 'inside.txt'), newPath: path.join(project, 'c', 'moved.txt') })).statusCode).toBe(200);
    expect((await call('/api/fs/delete', { path: path.join(project, 'link') })).statusCode).toBe(200);
    expect(await exists(path.join(project, 'link'))).toBe(false);
    expect(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep'); // Only the link went.
    expect(await fs.readFile(path.join(project, 'a', 'b.txt'), 'utf8')).toBe('ok');
    expect(await exists(path.join(project, 'c', 'moved.txt'))).toBe(true);
  });
});

describe('containment review cases (OC100 pass 1)', () => {
  let root, fs;
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain2-')));
    for (const dir of ['project', 'outside', 'disk/chats', 'config']) await fs.mkdir(path.join(root, dir), { recursive: true });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const setup = ({ resolveProjectDirectory, spawn = vi.fn() } = {}) => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn, crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: resolveProjectDirectory ?? (async () => ({ directory: path.join(root, 'project') })),
      resolveGitBinaryForSpawn: () => 'git', buildAugmentedPath: () => '/usr/bin',
      openchamberUserConfigRoot: path.join(root, 'config'), managedChatsRoot: path.join(root, 'config', 'chats'),
    });
    return async (name, body) => { const res = response(); await route(name)({ body, query: {}, get: () => null }, res); return res; };
  };

  it('a retargeted project-root alias cannot move the boundary', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(path.join(root, 'outside'), alias); // The alias now points outside; the validated root is project.
    const call = setup({ resolveProjectDirectory: async () => ({ directory: path.join(root, 'project'), requestedDirectory: alias }) });
    expect((await call('/api/fs/write', { path: path.join(alias, 'new', 'file.txt'), content: 'x' })).statusCode).toBe(403);
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });

  it('exec refuses a working directory that leaves through a symbolic link, before spawning', async () => {
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'project', 'link'));
    const spawn = vi.fn();
    const call = setup({ spawn });
    const res = await call('/api/fs/exec', { commands: ['touch created'], cwd: path.join(root, 'project', 'link') });
    expect(res.statusCode).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a symlink-relocated chats root under the config root still works', async () => {
    await fs.rm(path.join(root, 'config'), { recursive: true });
    await fs.mkdir(path.join(root, 'config'));
    await fs.symlink(path.join(root, 'disk', 'chats'), path.join(root, 'config', 'chats'));
    const call = setup();
    expect((await call('/api/fs/mkdir', { path: path.join(root, 'config', 'chats', 'session-a') })).statusCode).toBe(200);
    expect((await call('/api/fs/delete', { path: path.join(root, 'config', 'chats', 'session-a') })).statusCode).toBe(200);
  });

  it('a filesystem root is never a delete or rename entry', async () => {
    const call = setup({ resolveProjectDirectory: async () => ({ directory: '/' }) });
    expect((await call('/api/fs/delete', { path: '/' })).statusCode).toBe(403);
    expect((await call('/api/fs/rename', { oldPath: '/', newPath: path.join(root, 'moved') })).statusCode).toBe(403);
  });
});

describe('worktree fallback identity (OC100 pass 2)', () => {
  let root, fs;
  const git = async (cwd, ...args) => {
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
      (error) => (error ? reject(error) : resolve())));
  };
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain3-')));
    await fs.mkdir(path.join(root, 'repo')); await fs.mkdir(path.join(root, 'outside'));
    await git(path.join(root, 'repo'), 'init', '-q');
    await git(path.join(root, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(path.join(root, 'repo'), 'worktree', 'add', '-q', path.join(root, 'wt'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const call = async (target) => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: path.join(root, 'repo') }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'),
    });
    const res = response(); await route('/api/fs/write')({ body: { path: target, content: 'x' }, query: {}, get: () => null }, res); return res;
  };

  it('a live linked worktree is writable; one replaced by a link elsewhere is not', async () => {
    expect((await call(path.join(root, 'wt', 'ok.txt'))).statusCode).toBe(200);
    await fs.rename(path.join(root, 'wt'), path.join(root, 'wt-moved'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'wt'));
    expect([400, 403]).toContain((await call(path.join(root, 'wt', 'victim.txt'))).statusCode); // Refused, not written.
    // Even a copied .git marker does not make the outside folder that worktree: Git's backlink names the moved checkout.
    await fs.copyFile(path.join(root, 'wt-moved', '.git'), path.join(root, 'outside', '.git'));
    expect([400, 403]).toContain((await call(path.join(root, 'wt', 'victim2.txt'))).statusCode);
    await fs.rm(path.join(root, 'outside', '.git'));
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });
});

describe('canonical roots and directory grants (OC100 pass 2)', () => {
  let root, fs;
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain4-')));
    for (const dir of ['project', 'outside', 'config']) await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, 'outside', 'victim.txt'), 'keep');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const routes = (resolveProjectDirectory) => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory, resolveGitBinaryForSpawn: () => 'git',
      openchamberUserConfigRoot: path.join(root, 'config'), managedChatsRoot: path.join(root, 'config', 'chats'),
    });
    return route;
  };
  const upload = async (route, target) => {
    const { Readable } = await import('node:stream');
    const req = Object.assign(Readable.from([Buffer.from('x')]), { query: { path: target },
      headers: { 'content-type': 'application/octet-stream', 'content-length': '1' }, get: () => null });
    const res = response(); await route('/api/fs/upload')(req, res); return res;
  };

  it('upload follows the validated root, not a retargeted alias', async () => {
    const alias = path.join(root, 'alias'); await fs.symlink(path.join(root, 'outside'), alias);
    const route = routes(async () => ({ directory: path.join(root, 'project'), requestedDirectory: alias }));
    expect((await upload(route, path.join(alias, 'new.txt'))).statusCode).toBe(403);
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual(['victim.txt']);
  });

  it('a project root replaced by a link while its canonical path is cached grants nothing outside', async () => {
    const project = path.join(root, 'project');
    await fs.rm(project, { recursive: true }); await fs.symlink(path.join(root, 'outside'), project);
    const route = routes(async () => ({ directory: project })); // The runtime cache still reports the old root.
    const res = response(); await route('/api/fs/write')({ body: { path: path.join(project, 'new.txt'), content: 'x' }, query: {}, get: () => null }, res);
    expect(res.statusCode).toBe(403);
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual(['victim.txt']);
  });

  it('a managed root linked to a file grants nothing, and a root itself is never a write target', async () => {
    await fs.symlink(path.join(root, 'outside', 'victim.txt'), path.join(root, 'config', 'chats'));
    const route = routes(async () => ({ directory: path.join(root, 'project') }));
    const write = async (target) => { const res = response(); await route('/api/fs/write')({ body: { path: target, content: 'x' }, query: {}, get: () => null }, res); return res; };
    expect((await write(path.join(root, 'config', 'chats'))).statusCode).toBeGreaterThanOrEqual(400);
    expect(await fs.readFile(path.join(root, 'outside', 'victim.txt'), 'utf8')).toBe('keep');
    expect((await write(path.join(root, 'project'))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await fs.readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('pass-3 review cases', () => {
  let root, fs;
  const git = async (cwd, ...args) => {
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
      (error) => (error ? reject(error) : resolve())));
  };
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain5-')));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const write = async (project, target, extra = {}) => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: project }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'), ...extra,
    });
    const res = response(); await route('/api/fs/write')({ body: { path: target, content: 'x' }, query: {}, get: () => null }, res); return res;
  };

  it('a cached project root replaced by a link to another repository grants none of it', async () => {
    const project = path.join(root, 'project'), other = path.join(root, 'other');
    await fs.mkdir(other); await git(other, 'init', '-q'); await git(other, 'commit', '-q', '--allow-empty', '-m', 'x');
    await fs.symlink(other, project); // The runtime cache still reports `project` as the canonical root.
    expect([400, 403]).toContain((await write(project, path.join(other, 'victim.txt'))).statusCode);
    expect(await fs.readdir(other)).toEqual(['.git']);
  });

  it('a redirected ancestor with a copied worktree marker is not that worktree', async () => {
    const repo = path.join(root, 'repo'), trees = path.join(root, 'trees'), outside = path.join(root, 'outside');
    await fs.mkdir(repo); await fs.mkdir(trees); await git(repo, 'init', '-q'); await git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
    await git(repo, 'worktree', 'add', '-q', path.join(trees, 'wt'));
    expect((await write(repo, path.join(trees, 'wt', 'ok.txt'))).statusCode).toBe(200);
    await fs.mkdir(path.join(outside, 'wt'), { recursive: true });
    await fs.copyFile(path.join(trees, 'wt', '.git'), path.join(outside, 'wt', '.git'));
    await fs.rename(trees, path.join(root, 'trees-moved')); await fs.symlink(outside, trees);
    expect([400, 403]).toContain((await write(repo, path.join(trees, 'wt', 'victim.txt'))).statusCode);
    expect(await fs.readdir(path.join(outside, 'wt'))).toEqual(['.git']);
  });

  it('a relocated managed root that does not exist yet can be created', async () => {
    await fs.mkdir(path.join(root, 'project'));
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: path.join(root, 'project') }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'), managedChatsRoot: path.join(root, 'srv', 'chats'),
    });
    const res = response(); await route('/api/fs/mkdir')({ body: { path: path.join(root, 'srv', 'chats', 'day', 's1') }, query: {}, get: () => null }, res);
    expect(res.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'srv', 'chats', 'day', 's1'))).isDirectory()).toBe(true);
  });
});

describe('pass-4 worktree layouts', () => {
  let root, fs;
  const git = async (cwd, ...args) => {
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
      (error) => (error ? reject(error) : resolve())));
  };
  beforeEach(async () => {
    fs = (await import('node:fs/promises')).default;
    const os = await import('node:os');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain6-')));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const write = async (project, target) => {
    const { app, route } = registry();
    registerFsRoutes(app, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: project }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'),
    });
    const res = response(); await route('/api/fs/write')({ body: { path: target, content: 'x' }, query: {}, get: () => null }, res); return res;
  };

  it('a sibling of a bare-backed checkout stays writable', async () => {
    const seed = path.join(root, 'seed'), bare = path.join(root, 'repo.git');
    await fs.mkdir(seed); await git(seed, 'init', '-q', '-b', 'main'); await git(seed, 'commit', '-q', '--allow-empty', '-m', 'x');
    await git(root, 'clone', '-q', '--bare', seed, bare);
    await git(bare, 'worktree', 'add', '-q', path.join(root, 'a'), '-b', 'a');
    await git(bare, 'worktree', 'add', '-q', path.join(root, 'b'), '-b', 'b');
    expect((await write(path.join(root, 'a'), path.join(root, 'b', 'ok.txt'))).statusCode).toBe(200);
  });

  it('a worktree whose administrative name starts with two dots stays writable', async () => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo); await git(repo, 'init', '-q'); await git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
    await git(repo, 'worktree', 'add', '-q', '-b', 'scratch', path.join(root, '..scratch'));
    expect((await write(repo, path.join(root, '..scratch', 'ok.txt'))).statusCode).toBe(200);
  });
});

describe('pass-5: the server-resolved Git executable', () => {
  it('worktree identity uses the Git executable the server resolved', async () => {
    const fs = (await import('node:fs/promises')).default, os = await import('node:os');
    const { execFile, execFileSync } = await import('node:child_process');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain7-')));
    try {
      const git = (cwd, ...args) => new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
        (error) => (error ? reject(error) : resolve())));
      const repo = path.join(root, 'repo'); await fs.mkdir(repo);
      await git(repo, 'init', '-q'); await git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
      await git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'));
      const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim(), log = path.join(root, 'used');
      const wrapper = path.join(root, 'resolved-git'); // Stands in for OPENCHAMBER_GIT_BINARY outside PATH.
      await fs.writeFile(wrapper, `#!/bin/sh\necho used >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
      const { app, route } = registry();
      registerFsRoutes(app, {
        os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
        normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: repo }),
        resolveGitBinaryForSpawn: () => wrapper, openchamberUserConfigRoot: path.join(root, 'config'),
      });
      const res = response(); await route('/api/fs/write')({ body: { path: path.join(root, 'wt', 'ok.txt'), content: 'x' }, query: {}, get: () => null }, res);
      expect(res.statusCode).toBe(200);
      expect((await fs.readFile(log, 'utf8')).trim()).toBe('used');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('pass-6: batch-file Git overrides', () => {
  it('a .cmd override runs through its adjacent executable', async () => {
    const fs = (await import('node:fs/promises')).default, os = await import('node:os');
    const { execFile, execFileSync } = await import('node:child_process');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain8-')));
    try {
      const git = (cwd, ...args) => new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
        (error) => (error ? reject(error) : resolve())));
      const repo = path.join(root, 'repo'); await fs.mkdir(repo);
      await git(repo, 'init', '-q'); await git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
      await git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'));
      const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim(), log = path.join(root, 'used');
      await fs.writeFile(path.join(root, 'git.cmd'), 'not executable by execFile\n'); // The batch wrapper itself.
      await fs.writeFile(path.join(root, 'git.exe'), `#!/bin/sh\necho exe >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
      const { app, route } = registry();
      registerFsRoutes(app, {
        os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
        normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: repo }),
        resolveGitBinaryForSpawn: () => path.join(root, 'git.cmd'), openchamberUserConfigRoot: path.join(root, 'config'),
      });
      const res = response(); await route('/api/fs/write')({ body: { path: path.join(root, 'wt', 'ok.txt'), content: 'x' }, query: {}, get: () => null }, res);
      expect(res.statusCode).toBe(200);
      expect((await fs.readFile(log, 'utf8')).trim()).toBe('exe');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('pass-7: native .com Git overrides', () => {
  it('a native .com override without an adjacent .exe runs itself', async () => {
    const fs = (await import('node:fs/promises')).default, os = await import('node:os');
    const { execFile, execFileSync } = await import('node:child_process');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contain9-')));
    try {
      const git = (cwd, ...args) => new Promise((resolve, reject) => execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd },
        (error) => (error ? reject(error) : resolve())));
      const repo = path.join(root, 'repo'); await fs.mkdir(repo);
      await git(repo, 'init', '-q'); await git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
      await git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'));
      const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim(), log = path.join(root, 'used');
      const shim = path.join(root, 'git-shim.com');
      await fs.writeFile(shim, `#!/bin/sh\necho com >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
      const { app, route } = registry();
      registerFsRoutes(app, {
        os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
        normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: repo }),
        resolveGitBinaryForSpawn: () => shim, openchamberUserConfigRoot: path.join(root, 'config'),
      });
      const res = response(); await route('/api/fs/write')({ body: { path: path.join(root, 'wt', 'ok.txt'), content: 'x' }, query: {}, get: () => null }, res);
      expect(res.statusCode).toBe(200);
      expect((await fs.readFile(log, 'utf8')).trim()).toBe('com');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
