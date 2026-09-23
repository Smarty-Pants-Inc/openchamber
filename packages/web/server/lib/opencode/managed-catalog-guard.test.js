import crypto from 'crypto';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerManagedCatalogGuard, MANAGED_CATALOG_ENV } from './managed-catalog-guard.js';
import { createManagedCatalogReader } from './managed-catalog-reader.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerFsRoutes } from '../fs/routes.js';

// #126 item 8: the managed launcher owns the catalog; this server never creates folders or projects.
const managed = { [MANAGED_CATALOG_ENV]: '1' };
const savedProject = { id: 'saved', path: '/saved', label: 'Saved' };
const liveProject = { id: 'live', path: '/live/project', label: 'Live' };

// The gateway's live managed rows; `null` means the catalog read fails.
const gateway = (rows) => vi.fn(async () => (rows === null
  ? new Response('down', { status: 502 })
  : Response.json(rows.map((worktree) => ({ id: worktree, worktree })), { headers: { 'x-smarty-code-catalog': 'managed-v1' } })));

const createApp = (env, liveRows = [liveProject.path]) => {
  const app = express();
  app.use(express.json());
  const fsPromises = {
    mkdir: vi.fn(async () => undefined),
    realpath: async (target) => target,
    stat: async () => ({ isDirectory: () => true }),
    access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  const persistSettings = vi.fn(async (settings) => settings);
  const readSettingsFromDisk = vi.fn(async () => ({ projects: [savedProject, liveProject] }));
  const sanitizeProjects = (projects) => projects;
  const spawn = vi.fn();
  const fetch = gateway(liveRows);
  const { isLiveDirectory } = createManagedCatalogReader({
    buildOpenCodeUrl: (route) => `http://gateway${route}`, getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }), fetch,
  });
  registerManagedCatalogGuard(app, { env, readSettingsFromDisk, sanitizeProjects, isLiveDirectory });
  registerOpenCodeRoutes(app, {
    crypto,
    fsPromises,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    readSettingsFromDisk,
    sanitizeProjects,
    persistSettings,
    formatSettingsResponse: (settings) => settings,
  });
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises,
    spawn,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: '/home/user/.config',
    env,
  });
  return { app, fetch, fsPromises, persistSettings, spawn };
};

describe('managed catalog server boundary', () => {
  it('refuses folder creation and project registration before any change', async () => {
    const { app, fsPromises, persistSettings, spawn } = createApp(managed);

    for (const [route, body] of [
      ['/api/opencode/directory', { path: '/home/paul/Projects/typed', create: true }],
      ['/api/opencode/directory', { path: '/existing' }],
      // No explicit project directory and not inside the chats root: refused by the fs route.
      ['/api/fs/mkdir', { path: '/repo/new' }],
      ['/api/fs/clone', { remoteUrl: 'https://example.com/r.git', destinationPath: '/repo/r' }],
    ]) {
      const response = await request(app).post(route).send(body).expect(403);
      expect(response.body.error).toContain('managed project catalog');
    }
    expect(fsPromises.mkdir).not.toHaveBeenCalled();
    expect(persistSettings).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a settings write that adds a project but keeps bookmark edits', async () => {
    const { app, persistSettings } = createApp(managed);

    await request(app).put('/api/config/settings')
      .send({ projects: [savedProject, { id: 'new', path: '/new' }] }).expect(403);
    expect(persistSettings).not.toHaveBeenCalled();

    await request(app).put('/api/config/settings')
      .send({ projects: [{ ...savedProject, label: 'Renamed' }, liveProject] }).expect(200);
    await request(app).put('/api/config/settings').send({ lastDirectory: `${liveProject.path}/` }).expect(200);
    expect(persistSettings).toHaveBeenCalledTimes(2);
  });

  it('accepts navigation pointers only for live rows, read from the gateway', async () => {
    const { app, fetch, persistSettings } = createApp(managed);

    for (const body of [{ lastDirectory: '/unadmitted' }, { lastDirectory: savedProject.path },
      { activeProjectId: savedProject.id }, { activeProjectId: 'unknown' },
      { projects: [savedProject, liveProject], activeProjectId: savedProject.id }]) {
      const response = await request(app).put('/api/config/settings').send(body).expect(403);
      expect(response.body.error).toContain('managed project catalog');
    }
    expect(persistSettings).not.toHaveBeenCalled();

    await request(app).put('/api/config/settings').send({ activeProjectId: liveProject.id, lastDirectory: liveProject.path }).expect(200);
    await request(app).put('/api/config/settings').send({ lastDirectory: '', activeProjectId: null }).expect(200);
    expect(persistSettings).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith('http://gateway/project', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test' }),
    }));
  });

  it('refuses navigation pointers when the live catalog cannot be read', async () => {
    const { app, persistSettings } = createApp(managed, null);
    await request(app).put('/api/config/settings').send({ lastDirectory: liveProject.path }).expect(503);
    await request(app).put('/api/config/settings').send({ activeProjectId: liveProject.id }).expect(503);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('the catalog reader fails closed on an unmarked or malformed response', async () => {
    const marked = { 'x-smarty-code-catalog': 'managed-v1' };
    for (const response of [
      Response.json([{ worktree: liveProject.path }]),
      Response.json([{ worktree: 'relative/path' }], { headers: marked }),
      Response.json([{ worktree: '/live/../escape' }], { headers: marked }),
      Response.json({ worktree: liveProject.path }, { headers: marked }),
      Response.json([{ worktree: [liveProject.path] }], { headers: marked }),
    ]) {
      const { isLiveDirectory } = createManagedCatalogReader({
        buildOpenCodeUrl: (route) => route, getOpenCodeAuthHeaders: () => ({}), fetch: async () => response,
      });
      await expect(isLiveDirectory(liveProject.path)).rejects.toThrow();
    }
  });

  it('leaves stock behaviour unchanged when the flag is unset', async () => {
    const { app, fsPromises, persistSettings } = createApp({});

    await request(app).post('/api/opencode/directory').send({ path: '/projects/new', create: true }).expect(200);
    await request(app).post('/api/fs/mkdir').send({ path: '/repo/new' }).expect(200);
    await request(app).put('/api/config/settings').send({ projects: [savedProject, { id: 'new', path: '/new' }] }).expect(200);
    expect(fsPromises.mkdir).toHaveBeenCalledTimes(2);
    expect(persistSettings).toHaveBeenCalledTimes(2);
  });
});
