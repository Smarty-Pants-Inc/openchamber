import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { runInNewContext } from 'node:vm';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';
import { createSettingsRevision, parseIfMatch } from './settings-revision.js';

const createRuntime = async (overrides = {}) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (_current, changes) => changes,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
    ...overrides,
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('uses OpenChamber themes when a new install has no theme preferences', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'openchamber-light',
        darkThemeId: 'openchamber-dark',
      });
    } finally {
      await cleanup();
    }
  });

  // #126 item 8: a managed catalog never turns a saved lastDirectory into a project.
  for (const [mode, env, count] of [['stock', {}, 1], ['managed', { OPENCHAMBER_MANAGED_CATALOG: '1' }, 0]]) {
    it(`legacy lastDirectory migration registers ${count} project(s) in ${mode} mode`, async () => {
      const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ env });
      try {
        await fsPromises.writeFile(settingsFilePath, JSON.stringify({ lastDirectory: tempRoot }), 'utf8');
        const settings = await runtime.readSettingsFromDiskMigrated();
        expect(settings.projects ?? []).toHaveLength(count);
      } finally {
        await cleanup();
      }
    });
  }

  it('preserves existing theme preferences during theme migration', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      }), 'utf8');

      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      });
    } finally {
      await cleanup();
    }
  });

  it('round-trips shared sidebar preferences through settings.json', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    const preferences = {
      sidebarProjectDisplayMode: 'single',
      sidebarSessionGroupingMode: 'flat',
      sidebarProjectSortOrder: 'date-added',
      sidebarShowRecentSection: false,
    };
    try {
      await runtime.persistSettings(preferences);

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual(preferences);
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify(preferences, null, 2));
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('writes settings with restrictive directory and file permissions', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.writeSettingsToDisk({ desktopUiPassword: 'secret' });

      expect((await fsPromises.stat(tempRoot)).mode & 0o777).toBe(0o700);
      expect((await fsPromises.stat(settingsFilePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  it('only remaps project plan paths within the migrated storage directory', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, 'project');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, newProjectId);
      const siblingStorageDir = `${oldStorageDir}-sibling`;

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({
          projectPlanFiles: [
            { id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') },
            { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
          ],
        }, null, 2),
        'utf8',
      );

      await runtime.readSettingsFromDiskMigrated();

      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${newProjectId}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([
        { id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') },
        { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
      ]);
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')('falls back when Windows blocks atomic settings replacement', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    const wrappedFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await runtime.writeSettingsToDisk({ theme: 'dark' });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify({ theme: 'dark' }, null, 2));
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('cleans up orphaned settings.json.tmp files during startup migration', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const settingsDir = path.dirname(settingsFilePath);
      const orphan1 = path.join(settingsDir, 'settings.json.tmp-1234-11111-abc');
      const orphan2 = path.join(settingsDir, 'settings.json.tmp-5678-22222-def');
      const unrelated = path.join(settingsDir, 'other-file.json');

      await fsPromises.writeFile(orphan1, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(orphan2, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(unrelated, '{"keep": true}', 'utf8');
      await fsPromises.writeFile(settingsFilePath, '{"theme": "light"}', 'utf8');

      await runtime.readSettingsFromDiskMigrated();

      const files = await fsPromises.readdir(settingsDir);
      expect(files).toContain('settings.json');
      expect(files).toContain('other-file.json');
      expect(files).not.toContain('settings.json.tmp-1234-11111-abc');
      expect(files).not.toContain('settings.json.tmp-5678-22222-def');
    } finally {
      await cleanup();
    }
  });

  it('removes temp file when writeSettingsToDisk encounters a write error', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    let capturedTmp = null;
    const wrappedFs = {
      ...fsPromises,
      rename: async (src, dst) => {
        capturedTmp = src;
        const error = new Error('unexpected disk failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await expect(runtime.writeSettingsToDisk({ theme: 'dark' })).rejects.toThrow('unexpected disk failure');
      expect(capturedTmp).toBeTruthy();
      const files = await fsPromises.readdir(tempRoot);
      expect(files.some((f) => f.startsWith('settings.json.tmp-'))).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows only one competing conditional update for the same revision', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ value: 'base' });
      const revision = createSettingsRevision(crypto, await runtime.readSettingsFromDisk());
      const results = await Promise.allSettled([
        runtime.persistSettings({ value: 'first' }, parseIfMatch(revision)),
        runtime.persistSettings({ value: 'second' }, parseIfMatch(revision)),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ statusCode: 412 });
      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ value: 'first' });
    } finally {
      await cleanup();
    }
  });

  it('invalidates a guarded update after an ordinary writer commits', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ value: 'base' });
      const revision = createSettingsRevision(crypto, await runtime.readSettingsFromDisk());
      await runtime.persistSettings({ value: 'ordinary' });

      await expect(runtime.persistSettings({ value: 'guarded' }, parseIfMatch(revision)))
        .rejects.toMatchObject({ statusCode: 412 });
      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ value: 'ordinary' });
    } finally {
      await cleanup();
    }
  });

  it('rejects stale preconditions before tunnel side effects or a disk write', async () => {
    const syncManagedRemoteTunnelConfigWithPresets = vi.fn(async () => {});
    const onSettingsChanged = vi.fn(async () => {});
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      syncManagedRemoteTunnelConfigWithPresets,
      onSettingsChanged,
    });
    try {
      await runtime.persistSettings({ value: 'base' });
      const revision = createSettingsRevision(crypto, await runtime.readSettingsFromDisk());
      await runtime.persistSettings({ value: 'ordinary' });
      syncManagedRemoteTunnelConfigWithPresets.mockClear();
      onSettingsChanged.mockClear();
      const before = await fsPromises.readFile(settingsFilePath, 'utf8');

      await expect(runtime.persistSettings({ managedRemoteTunnelPresets: [{ id: 'stale' }] }, parseIfMatch(revision)))
        .rejects.toMatchObject({ statusCode: 412 });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(before);
      expect(syncManagedRemoteTunnelConfigWithPresets).not.toHaveBeenCalled();
      expect(onSettingsChanged).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('continues processing settings writes after a failed operation', async () => {
    let writeAttempts = 0;
    const wrappedFs = {
      ...fsPromises,
      writeFile: async (...args) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw new Error('simulated disk failure');
        }
        return fsPromises.writeFile(...args);
      },
    };
    const { runtime, cleanup } = await createRuntime({ fsPromises: wrappedFs });
    try {
      await expect(runtime.persistSettings({ value: 'failed' })).rejects.toThrow('simulated disk failure');
      await expect(runtime.persistSettings({ value: 'saved' })).resolves.toEqual({ value: 'saved' });
      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ value: 'saved' });
    } finally {
      await cleanup();
    }
  });

  it('serializes a read migration before a guarded update', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ collapsedProjects: ['legacy'] }), 'utf8');
      const staleRevision = createSettingsRevision(crypto, { collapsedProjects: ['legacy'] });

      const migration = runtime.readSettingsFromDiskMigrated();
      const guardedUpdate = runtime.persistSettings({ value: 'guarded' }, parseIfMatch(staleRevision));

      await expect(migration).resolves.not.toHaveProperty('collapsedProjects');
      await expect(guardedUpdate).rejects.toMatchObject({ statusCode: 412 });
      await expect(runtime.readSettingsFromDisk()).resolves.not.toHaveProperty('collapsedProjects');
      await expect(runtime.readSettingsFromDisk()).resolves.not.toHaveProperty('value');
    } finally {
      await cleanup();
    }
  });

  it('notifies only after durable formatted settings changes', async () => {
    const onSettingsChanged = vi.fn(async () => {});
    const { runtime, cleanup } = await createRuntime({ onSettingsChanged });
    try {
      await runtime.persistSettings({ value: 'one' });
      await runtime.persistSettings({ value: 'one' });
      await expect(runtime.writeSettingsToDisk({ value: 'two' })).resolves.toBeUndefined();

      expect(onSettingsChanged).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
    }
  });

  it('accepts a settings notification callback from another realm', async () => {
    const notified = vi.fn();
    const onSettingsChanged = runInNewContext('() => notified()', { notified });
    const { runtime, cleanup } = await createRuntime({ onSettingsChanged });
    try {
      await runtime.persistSettings({ value: 'saved' });
      expect(notified).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it('keeps a durable write successful when its notification callback fails', async () => {
    const onSettingsChanged = vi.fn(async () => {
      throw new Error('notification unavailable');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, cleanup } = await createRuntime({ onSettingsChanged });
    try {
      await expect(runtime.persistSettings({ value: 'saved' })).resolves.toEqual({ value: 'saved' });
      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ value: 'saved' });
      expect(warning).toHaveBeenCalledWith('Settings changed notification failed.');
    } finally {
      warning.mockRestore();
      await cleanup();
    }
  });

  it.each(['{not-json', '[]', 'null'])('does not migrate or update invalid settings %s', async (invalid) => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutation = vi.fn(current => ({ ...current, value: 'must-not-write' }));
    const recoveryFile = `${settingsFilePath}.tmp-recovery`;
    try {
      await fsPromises.writeFile(settingsFilePath, invalid, 'utf8');
      await fsPromises.writeFile(recoveryFile, 'recoverable', 'utf8');
      await expect(runtime.readSettingsFromDiskMigrated()).rejects.toThrow();
      await expect(runtime.persistSettings({ value: 'must-not-write' })).rejects.toThrow();
      await expect(runtime.writeSettingsToDisk(mutation)).rejects.toThrow();
      expect(mutation).not.toHaveBeenCalled();
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(invalid);
      await expect(fsPromises.readFile(recoveryFile, 'utf8')).resolves.toBe('recoverable');
      // An explicit full replacement still permits deliberate recovery.
      await runtime.writeSettingsToDisk({ value: 'recovered' });
      await expect(runtime.persistSettings({ value: 'queue-recovered' })).resolves.toEqual({ value: 'queue-recovered' });
    } finally {
      warning.mockRestore();
      await cleanup();
    }
  });

  it('derives a raw update from current settings after a guarded project write', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    try {
      await runtime.writeSettingsToDisk({
        projects: [{ id: 'project', path: tempRoot, label: 'Original' }],
        sidebarProjectDisplayMode: 'single',
      });
      const current = await runtime.readSettingsFromDisk();
      const revision = createSettingsRevision(crypto, current);
      await runtime.persistSettings({
        projects: current.projects.map((project) => ({ ...project, label: 'Browser' })),
      }, parseIfMatch(revision));

      await runtime.writeSettingsToDisk((queuedCurrent) => ({
        ...queuedCurrent,
        privateRelay: { enabled: true, relayUrl: 'wss://relay.example.test/ws' },
      }));

      await expect(runtime.readSettingsFromDisk()).resolves.toMatchObject({
        projects: [expect.objectContaining({ label: 'Browser' })],
        sidebarProjectDisplayMode: 'single',
        privateRelay: { enabled: true, relayUrl: 'wss://relay.example.test/ws' },
      });
    } finally {
      await cleanup();
    }
  });

  it('keeps a saved bookmark whose folder is briefly absent across an unrelated edit; only omission removes it', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      const [a, b] = ['a', 'b'].map((name) => path.join(tempRoot, name));
      await fsPromises.mkdir(a); await fsPromises.mkdir(b);
      const project = (dir, label) => ({ id: createProjectIdFromPath(dir), path: dir, label });
      await runtime.persistSettings({ projects: [project(a, 'A'), project(b, 'B')], activeProjectId: project(a).id });
      await fsPromises.rm(b, { recursive: true }); // B's worktree is being recreated.
      await runtime.persistSettings({ projects: [project(a, 'Renamed A'), project(b, 'B')] });
      expect((await runtime.readSettingsFromDisk()).projects.map((entry) => entry.label)).toEqual(['Renamed A', 'B']);
      const missingNew = path.join(tempRoot, 'never-created'); // A new path must still exist to be added.
      await runtime.persistSettings({ projects: [project(a, 'Renamed A'), project(b, 'B'), project(missingNew, 'N')] });
      expect((await runtime.readSettingsFromDisk()).projects.map((entry) => entry.label)).toEqual(['Renamed A', 'B']);
      await runtime.persistSettings({ projects: [project(a, 'Renamed A')] }); // Explicit removal.
      expect((await runtime.readSettingsFromDisk()).projects.map((entry) => entry.label)).toEqual(['Renamed A']);
    } finally {
      await cleanup();
    }
  });
});
