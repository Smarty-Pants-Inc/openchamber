import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSettingsRuntime } from '../opencode/settings-runtime.js';

const temporaryRoots = [];

async function createRuntime({ pauseRename = false } = {}) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-preference-settings-'));
  temporaryRoots.push(root);
  vi.stubEnv('OPENCHAMBER_DATA_DIR', root);
  vi.resetModules();
  const github = await import('./auth.js');
  const linear = await import('../linear/auth.js');
  const { registerLinearRoutes } = await import('../linear/routes.js');
  const { registerGitHubRoutes } = await import('./routes.js');
  const settingsFilePath = path.join(root, 'settings.json');
  let pauseStarted;
  let releasePause;
  const renamePaused = new Promise((resolve) => { pauseStarted = resolve; });
  const resumeRename = new Promise((resolve) => { releasePause = resolve; });
  let shouldPause = pauseRename;
  const controlledFs = {
    ...fsPromises,
    async rename(source, target) {
      if (shouldPause && target === settingsFilePath) {
        shouldPause = false;
        pauseStarted();
        await resumeRename;
      }
      return fsPromises.rename(source, target);
    },
  };
  const runtime = createSettingsRuntime({
    fsPromises: controlledFs,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
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
  return { settingsFilePath, runtime, renamePaused, releasePause, github, linear, registerLinearRoutes, registerGitHubRoutes };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('GitHub and Linear settings preferences', () => {
  it('preserves both preferences when a queued write pauses after its current read', async () => {
    const { settingsFilePath, runtime, renamePaused, releasePause, github, linear } = await createRuntime({ pauseRename: true });
    await fsPromises.writeFile(settingsFilePath, JSON.stringify({ projects: [{ id: 'keep' }] }), 'utf8');
    const queued = runtime.writeSettingsToDisk((current) => ({ ...current, scalar: 'queued' }));
    await renamePaused;
    const disableGhCli = github.setGhCliDisabled(true, runtime.writeSettingsToDisk);
    const enableLinearComments = linear.setLinearSessionCommentsEnabled(true, runtime.writeSettingsToDisk);
    releasePause();
    await Promise.all([queued, disableGhCli, enableLinearComments]);

    await expect(runtime.readSettingsFromDiskStrict()).resolves.toEqual({
      projects: [{ id: 'keep' }],
      scalar: 'queued',
      ghCliDisabled: true,
      ghCliActive: false,
      linearSessionComments: true,
    });
  });

  it('waits for the Linear preference route to persist its response', async () => {
    const { runtime, renamePaused, releasePause, registerLinearRoutes } = await createRuntime({ pauseRename: true });
    const app = express();
    app.use(express.json());
    registerLinearRoutes(app, { writeSettingsToDisk: runtime.writeSettingsToDisk });

    let completed = false;
    const response = request(app)
      .put('/api/linear/preferences')
      .send({ sessionComments: true })
      .then((value) => {
        completed = true;
        return value;
      });
    await renamePaused;
    expect(completed).toBe(false);
    releasePause();

    await expect(response).resolves.toMatchObject({ status: 200, body: { sessionComments: true } });
  });

  it('waits for the GitHub CLI preference route to persist its response', async () => {
    const { runtime, renamePaused, releasePause, registerGitHubRoutes } = await createRuntime({ pauseRename: true });
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, { writeSettingsToDisk: runtime.writeSettingsToDisk });

    let completed = false;
    const response = request(app)
      .post('/api/github/auth/gh-cli')
      .send({ disabled: true })
      .then((value) => {
        completed = true;
        return value;
      });
    await renamePaused;
    expect(completed).toBe(false);
    releasePause();

    await expect(response).resolves.toMatchObject({ status: 200, body: { disabled: true } });
  });

  it('keeps malformed private settings out of preference responses and logs', async () => {
    const { settingsFilePath, runtime, registerGitHubRoutes, registerLinearRoutes } = await createRuntime();
    const invalid = '{"managedRemoteTunnelToken": SYNTHETIC_PRIVATE_VALUE}';
    await fsPromises.writeFile(settingsFilePath, invalid);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = express(); app.use(express.json());
      registerGitHubRoutes(app, { writeSettingsToDisk: runtime.writeSettingsToDisk });
      registerLinearRoutes(app, { writeSettingsToDisk: runtime.writeSettingsToDisk });
      const responses = [
        await request(app).post('/api/github/auth/gh-cli').send({ disabled: true }),
        await request(app).put('/api/linear/preferences').send({ sessionComments: true }),
      ];
      expect(responses.map((response) => response.status)).toEqual([500, 500]);
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe(invalid);
      await runtime.readSettingsFromDisk();
      await runtime.writeSettingsToDisk({ projects: [] });
      expect({ responseLeaks: responses.map((response) => response.text.includes('SYNTHETIC')),
        logLeaks: inspect([errors.mock.calls, warnings.mock.calls], { depth: null }).includes('SYNTHETIC') })
        .toEqual({ responseLeaks: [false, false], logLeaks: false });
      expect(await runtime.readSettingsFromDiskStrict()).toEqual({ projects: [] });
    } finally { errors.mockRestore(); warnings.mockRestore(); }
  });

  it.each(['{not-json', '[]', 'null'])('rejects invalid settings %s without replacing them, then recovers', async (invalid) => {
    const { settingsFilePath, runtime, github, linear } = await createRuntime();
    const outcomes = [];
    for (const setter of [github.setGhCliDisabled, github.setGhCliActive, linear.setLinearSessionCommentsEnabled]) {
      await fsPromises.writeFile(settingsFilePath, invalid, 'utf8');
      const rejected = await Promise.resolve().then(() => setter(true, runtime.writeSettingsToDisk)).then(() => false, () => true);
      outcomes.push({ rejected, retained: await fsPromises.readFile(settingsFilePath, 'utf8') === invalid });
    }
    expect(outcomes).toEqual(Array(3).fill({ rejected: true, retained: true }));

    await runtime.writeSettingsToDisk({ projects: [{ id: 'keep' }] });
    await expect(linear.setLinearSessionCommentsEnabled(true, runtime.writeSettingsToDisk)).resolves.toBe(true);
    await expect(runtime.readSettingsFromDiskStrict()).resolves.toEqual({
      projects: [{ id: 'keep' }],
      linearSessionComments: true,
    });
  });
});
