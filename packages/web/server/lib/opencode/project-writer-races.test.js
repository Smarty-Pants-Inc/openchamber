import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectIdFromPath } from '../projects/project-id.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { createSettingsRuntime } from './settings-runtime.js';
import { createSettingsRevision, parseIfMatch } from './settings-revision.js';

const temporaryRoots = [];

const createRuntime = async () => {
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-project-writers-'));
  temporaryRoots.push(temporaryRoot);
  const projectPath = path.join(temporaryRoot, 'project');
  await fsPromises.mkdir(projectPath);
  const projectId = createProjectIdFromPath(projectPath);
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: path.join(temporaryRoot, 'settings.json'),
    sanitizeProjects: (projects) => projects,
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  await runtime.persistSettings({
    projects: [{ id: projectId, path: projectPath, label: 'Original', addedAt: 1, lastOpenedAt: 1 }],
    activeProjectId: projectId,
  });
  return { runtime, temporaryRoot, projectId };
};

const renameProjectConditionally = async (runtime, projectId) => {
  const current = await runtime.readSettingsFromDisk();
  const revision = createSettingsRevision(crypto, current);
  return runtime.persistSettings({
    projects: current.projects.map((project) => project.id === projectId ? { ...project, label: 'Browser' } : project),
  }, parseIfMatch(revision));
};

const deleteProjectConditionally = async (runtime) => {
  const current = await runtime.readSettingsFromDisk();
  const revision = createSettingsRevision(crypto, current);
  return runtime.persistSettings({ projects: [] }, parseIfMatch(revision));
};

const createApp = ({ runtime, temporaryRoot, validateDirectoryPath, iconFsPromises = fsPromises,
  directoryPersistSettings = runtime.persistSettings }) => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    crypto,
    formatSettingsResponse: (settings) => settings,
    readSettingsFromDisk: runtime.readSettingsFromDisk,
    readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
    persistSettings: directoryPersistSettings,
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath,
  });
  registerProjectIconRoutes(app, {
    fsPromises: iconFsPromises,
    path,
    crypto,
    openchamberDataDir: temporaryRoot,
    sanitizeProjects: (projects) => projects,
    readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
    persistSettings: runtime.persistSettings,
    createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
    spawn: vi.fn(),
    resolveGitBinaryForSpawn: vi.fn(),
  });
  return app;
};

const createPausedIconFs = (temporaryRoot) => {
  let releaseIconWrite;
  let markIconWriteStarted;
  const iconWriteStarted = new Promise((resolve) => {
    markIconWriteStarted = resolve;
  });
  const allowIconWrite = new Promise((resolve) => {
    releaseIconWrite = resolve;
  });
  return {
    iconWriteStarted,
    releaseIconWrite: () => releaseIconWrite(),
    iconFsPromises: {
      ...fsPromises,
      writeFile: async (filePath, content, options) => {
        if (filePath.startsWith(path.join(temporaryRoot, 'project-icons'))) {
          markIconWriteStarted();
          await allowIconWrite;
        }
        return fsPromises.writeFile(filePath, content, options);
      },
    },
  };
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((temporaryRoot) => fsPromises.rm(temporaryRoot, { recursive: true, force: true })));
});

describe('project settings writers', () => {
  it('preserves a guarded browser rename while a directory writer is paused', async () => {
    const { runtime, temporaryRoot, projectId } = await createRuntime();
    const newProjectPath = path.join(temporaryRoot, 'new-project');
    await fsPromises.mkdir(newProjectPath);
    let releaseWrite, markWriteStarted;
    const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
    const allowWrite = new Promise((resolve) => { releaseWrite = resolve; });
    const app = createApp({ runtime, temporaryRoot,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      directoryPersistSettings: async (...args) => {
        markWriteStarted();
        await allowWrite;
        return runtime.persistSettings(...args);
      },
    });

    const directoryRequest = request(app)
      .post('/api/opencode/directory')
      .send({ path: newProjectPath })
      .then((response) => response);
    await writeStarted;
    await renameProjectConditionally(runtime, projectId);
    releaseWrite();

    await expect(directoryRequest).resolves.toMatchObject({ status: 200 });
    const settings = await runtime.readSettingsFromDisk();
    expect(settings.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: projectId, label: 'Browser' }),
      expect.objectContaining({ path: newProjectPath }),
    ]));
  });

  it('preserves a guarded browser rename while an icon upload is paused', async () => {
    const { runtime, temporaryRoot, projectId } = await createRuntime();
    const pausedIconFs = createPausedIconFs(temporaryRoot);
    const app = createApp({
      runtime,
      temporaryRoot,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      iconFsPromises: pausedIconFs.iconFsPromises,
    });

    const upload = request(app)
      .put(`/api/projects/${projectId}/icon`)
      .send({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
      .then((response) => response);
    await pausedIconFs.iconWriteStarted;
    await renameProjectConditionally(runtime, projectId);
    pausedIconFs.releaseIconWrite();

    const response = await upload;
    expect(response.status).toBe(200);
    expect(response.body.project).toMatchObject({ id: projectId, label: 'Browser' });
    expect(response.body.project.iconImage).toMatchObject({ mime: 'image/png', source: 'custom' });
  });

  it('fails an icon update honestly when the target is removed while it is paused', async () => {
    const { runtime, temporaryRoot, projectId } = await createRuntime();
    const pausedIconFs = createPausedIconFs(temporaryRoot);
    const app = createApp({
      runtime,
      temporaryRoot,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      iconFsPromises: pausedIconFs.iconFsPromises,
    });

    const upload = request(app)
      .put(`/api/projects/${projectId}/icon`)
      .send({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
      .then((response) => response);
    await pausedIconFs.iconWriteStarted;
    await deleteProjectConditionally(runtime);
    pausedIconFs.releaseIconWrite();

    await expect(upload).resolves.toMatchObject({ status: 404, body: { error: 'Project not found' } });
    await expect(runtime.persistSettings({ value: 'queue-recovered' })).resolves.toMatchObject({ value: 'queue-recovered' });
  });
});
