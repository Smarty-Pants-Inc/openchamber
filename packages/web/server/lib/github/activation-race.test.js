import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSettingsRuntime } from '../opencode/settings-runtime.js';

const temporaryRoots = [];

async function createRuntime() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-github-activation-'));
  temporaryRoots.push(root);
  vi.stubEnv('OPENCHAMBER_DATA_DIR', root);
  vi.resetModules();
  const github = await import('./auth.js');
  const settingsFilePath = path.join(root, 'settings.json');
  let renamed;
  let resume;
  const renamePaused = new Promise((resolve) => { renamed = resolve; });
  const resumeRename = new Promise((resolve) => { resume = resolve; });
  let shouldPause = true;
  const controlledFs = {
    ...fsPromises,
    async rename(source, target) {
      if (shouldPause && target === settingsFilePath) {
        shouldPause = false;
        renamed();
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
  return { github, root, runtime, renamePaused, resume };
}

function addAccount(github, accountId) {
  github.setGitHubAuth({
    accessToken: `synthetic-${accountId}`,
    user: { id: accountId, login: accountId },
    accountId,
  });
}

async function pauseActivation(github, runtime, renamePaused, accountId) {
  const activation = github.activateGitHubAuth(accountId, runtime.writeSettingsToDisk);
  await renamePaused;
  return { activation };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryRoots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true })));
});

describe('GitHub activation after settings persistence', () => {
  it('returns false when the target is removed while settings persistence is paused', async () => {
    const { github, runtime, renamePaused, resume } = await createRuntime();
    addAccount(github, 'a');

    const { activation } = await pauseActivation(github, runtime, renamePaused, 'a');
    expect(github.clearGitHubAuth()).toBe(true);
    resume();

    await expect(activation).resolves.toBe(false);
    expect(github.getGitHubAuthAccounts()).toEqual([]);
  });

  it('preserves removal of an unrelated current account', async () => {
    const { github, runtime, renamePaused, resume } = await createRuntime();
    addAccount(github, 'a');
    addAccount(github, 'b');

    const { activation } = await pauseActivation(github, runtime, renamePaused, 'a');
    expect(github.clearGitHubAuth()).toBe(true);
    resume();

    await expect(activation).resolves.toBe(true);
    expect(github.getGitHubAuthAccounts()).toEqual([{
      id: 'a',
      user: { id: null, login: 'a', avatarUrl: null, name: null, email: null },
      scope: '',
      current: true,
    }]);
  });

  it('preserves an account added while settings persistence is paused', async () => {
    const { github, runtime, renamePaused, resume } = await createRuntime();
    addAccount(github, 'a');
    addAccount(github, 'b');

    const { activation } = await pauseActivation(github, runtime, renamePaused, 'a');
    addAccount(github, 'c');
    resume();

    await expect(activation).resolves.toBe(true);
    expect(github.getGitHubAuthAccounts().map((account) => account.id).sort()).toEqual(['a', 'b', 'c']);
    expect(github.getGitHubAuth()).toMatchObject({ accountId: 'a', accessToken: 'synthetic-a' });
    const stored = JSON.parse(await fsPromises.readFile(github.GITHUB_AUTH_FILE, 'utf8'));
    expect(stored.find((account) => account.accountId === 'c')).toMatchObject({ accessToken: 'synthetic-c' });
  });

  it('does not write settings when the target is initially missing', async () => {
    const { github, runtime } = await createRuntime();
    const writeSettingsToDisk = vi.fn(runtime.writeSettingsToDisk);

    await expect(github.activateGitHubAuth('missing', writeSettingsToDisk)).resolves.toBe(false);
    expect(writeSettingsToDisk).not.toHaveBeenCalled();
  });
});
