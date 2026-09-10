import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { getOrCreateRelaySigningKeypair } from './signing-key.js';

const temporaryRoots = [];

const createRuntime = async () => {
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-raw-writers-'));
  temporaryRoots.push(temporaryRoot);
  const settingsFilePath = path.join(temporaryRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
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
  return { runtime, settingsFilePath };
};

const signingDeps = (runtime) => ({
  crypto,
  readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
  readSettingsStrict: runtime.readSettingsFromDiskStrict,
  writeSettingsToDisk: runtime.writeSettingsToDisk,
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((temporaryRoot) => fsPromises.rm(temporaryRoot, { recursive: true, force: true })));
});

describe('raw settings writers', () => {
  it('persists one signing identity for concurrent first use without replacing projects', async () => {
    const { runtime } = await createRuntime();
    await runtime.writeSettingsToDisk({
      projects: [{ id: 'project-1', path: '/project', label: 'Keep' }],
      sidebarProjectDisplayMode: 'single',
    });
    const generateKeyPairSync = vi.spyOn(crypto, 'generateKeyPairSync');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [first, second] = await Promise.all([
      getOrCreateRelaySigningKeypair(signingDeps(runtime)),
      getOrCreateRelaySigningKeypair(signingDeps(runtime)),
    ]);

    expect(generateKeyPairSync).toHaveBeenCalledTimes(1);
    expect(first.publicJwk).toEqual(second.publicJwk);
    await expect(runtime.readSettingsFromDisk()).resolves.toMatchObject({
      projects: [{ id: 'project-1', path: '/project', label: 'Keep' }],
      sidebarProjectDisplayMode: 'single',
    });
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each(['{not-json', '[]', 'null'])('refuses invalid settings %s before generating or replacing an identity', async (invalid) => {
    const { runtime, settingsFilePath } = await createRuntime();
    await fsPromises.writeFile(settingsFilePath, invalid, 'utf8');
    const generateKeyPairSync = vi.spyOn(crypto, 'generateKeyPairSync');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(getOrCreateRelaySigningKeypair(signingDeps(runtime))).rejects.toThrow();

    expect(generateKeyPairSync).not.toHaveBeenCalled();
    await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(invalid);
    expect(warning).not.toHaveBeenCalled();
  });
});
