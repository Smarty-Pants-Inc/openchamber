import crypto from 'crypto';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerManagedCatalogGuard, MANAGED_CATALOG_ENV } from './managed-catalog-guard.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerFsRoutes } from '../fs/routes.js';

// #126 item 8: the managed launcher owns the catalog; this server never creates folders or projects.
const managed = { [MANAGED_CATALOG_ENV]: '1' };
const savedProject = { id: 'saved', path: '/saved', label: 'Saved' };

const createApp = (env) => {
  const app = express();
  app.use(express.json());
  const fsPromises = {
    mkdir: vi.fn(async () => undefined),
    realpath: async (target) => target,
    stat: async () => ({ isDirectory: () => true }),
    access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  const persistSettings = vi.fn(async (settings) => settings);
  const readSettingsFromDisk = vi.fn(async () => ({ projects: [savedProject] }));
  const sanitizeProjects = (projects) => projects;
  const spawn = vi.fn();
  registerManagedCatalogGuard(app, { env, readSettingsFromDisk, sanitizeProjects });
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
  return { app, fsPromises, persistSettings, spawn };
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
      .send({ projects: [{ ...savedProject, label: 'Renamed' }] }).expect(200);
    await request(app).put('/api/config/settings').send({ lastDirectory: '/live' }).expect(200);
    expect(persistSettings).toHaveBeenCalledTimes(2);
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
