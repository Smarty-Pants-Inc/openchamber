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
