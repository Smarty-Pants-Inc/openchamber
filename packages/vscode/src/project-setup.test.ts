import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectSetupValidationError,
  mergeProjectSetup,
  normalizePlansDir,
  parseSharedProjectConfig,
  personalProjectSetupOf,
  projectSetupPatchToStored,
  sanitizeDraftStarters,
  sanitizeProjectActions,
  sanitizeSetupCommands,
  sharedTrustHashOf,
  type PersonalProjectSetup,
} from './project-setup';
import { createProjectSetupStore, handleProjectSetupBridgeMessage, projectConfigFileStemOf, projectPathFromId } from './bridge-project-setup-runtime';

const emptyPersonal: PersonalProjectSetup = {
  setupWorktree: [],
  setupWorktreeWait: null,
  setupWorktreeMode: 'append',
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  hiddenSharedActionIds: [],
  sharedTrust: null,
};

const projectIdFor = (projectPath: string): string => `path_${Buffer.from(projectPath, 'utf8').toString('base64url')}`;

describe('project setup sanitizers', () => {
  test('keeps only non-empty trimmed setup commands', () => {
    assert.deepEqual(sanitizeSetupCommands([' bun install ', '', 42, '\n']), ['bun install']);
    assert.deepEqual(sanitizeSetupCommands('bun install'), []);
  });

  test('drops incomplete actions and duplicate ids, keeps only set optional fields', () => {
    assert.deepEqual(sanitizeProjectActions([
      { id: 'a', name: 'Dev', command: 'bun run dev', runIn: 'parent', platforms: ['macos', 'plan9'], icon: '' },
      { id: 'a', name: 'Again', command: 'x' },
      { id: '', name: 'No id', command: 'x' },
      { id: 'b', name: 'B', command: 'x', runIn: 'worktree' },
    ]), [
      { id: 'a', name: 'Dev', command: 'bun run dev', icon: null, platforms: ['macos'], runIn: 'parent' },
      { id: 'b', name: 'B', command: 'x', icon: null },
    ]);
  });

  test('dedupes draft starters by type and name', () => {
    assert.deepEqual(sanitizeDraftStarters([
      { type: 'skill', name: 'triage-prs' },
      { type: 'skill', name: 'triage-prs' },
      { type: 'agent', name: 'nope' },
    ]), [{ type: 'skill', name: 'triage-prs' }]);
  });

  test('builds the personal view from on-disk keys and nulls a dangling primary action', () => {
    assert.deepEqual(personalProjectSetupOf({
      'setup-worktree': ['bun install'],
      'setup-worktree-wait': true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x' }],
      projectActionsPrimaryId: 'missing',
      hiddenSharedActionIds: ['dev', 'dev', 3],
    }), {
      setupWorktree: ['bun install'],
      setupWorktreeWait: true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x', icon: null }],
      projectActionsPrimaryId: null,
      draftStarters: [],
      hiddenSharedActionIds: ['dev'],
      sharedTrust: null,
    });
    assert.deepEqual(personalProjectSetupOf(null), emptyPersonal);
  });

  test('parses a shared file and refuses a broken one', () => {
    const ok = parseSharedProjectConfig(JSON.stringify({ version: 1, setupWorktree: ['bun install'], plansDir: 'docs/plans' }));
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') {
      assert.deepEqual(ok.config, { setupWorktree: ['bun install'], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: 'docs/plans' });
    }
    assert.equal(parseSharedProjectConfig('{ nope').status, 'invalid');
    assert.equal(parseSharedProjectConfig('{"version":2}').status, 'invalid');
    assert.equal(parseSharedProjectConfig('{"version":1,"plansDir":"../x"}').status, 'invalid');
    assert.equal(normalizePlansDir('./docs/plans/'), 'docs/plans');
    assert.equal(normalizePlansDir('/abs'), null);
  });

  test('merges shared and personal by the agreed rules', () => {
    const merged = mergeProjectSetup({
      ...emptyPersonal,
      setupWorktree: ['mine'],
      projectActions: [{ id: 'test', name: 'My test', command: 'x', icon: null }],
      hiddenSharedActionIds: ['lint'],
      draftStarters: [{ type: 'command', name: 'both' }, { type: 'command', name: 'mine' }],
    }, {
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [
          { id: 'dev', name: 'Dev', command: 'd', icon: null },
          { id: 'test', name: 'Test', command: 't', icon: null },
          { id: 'lint', name: 'Lint', command: 'l', icon: null },
        ],
        draftStarters: [{ type: 'command', name: 'both' }],
        plansDir: null,
      },
    });
    assert.deepEqual(merged.setupWorktree, ['bun install', 'mine']);
    assert.equal(merged.setupWorktreeWait, true);
    assert.deepEqual(merged.projectActions.map((action) => `${action.id}:${action.source}`), ['dev:shared', 'test:personal']);
    assert.deepEqual(merged.draftStarters.map((starter) => `${starter.name}:${starter.source}`), ['both:shared', 'mine:personal']);
    assert.equal(merged.trust.trusted, false);
    assert.match(merged.trust.hash ?? '', /^sha256:/);
  });

  test('trusts only the recorded hash and nothing when nothing executes', () => {
    const shared = { setupWorktree: ['bun install'], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null };
    const hash = sharedTrustHashOf(shared);
    assert.equal(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: hash ?? '', trustedAt: 1 } }, { status: 'ok', config: shared }).trust.trusted, true);
    assert.equal(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: 'sha256:old', trustedAt: 1 } }, { status: 'ok', config: shared }).trust.trusted, false);
    assert.deepEqual(mergeProjectSetup(emptyPersonal, { status: 'missing' }).trust, { hash: null, trusted: true });
    assert.equal(sharedTrustHashOf({ ...shared, setupWorktree: [] }), null);
    assert.deepEqual(projectSetupPatchToStored({ sharedTrustHash: null }), { sharedTrust: undefined });
    assert.throws(() => projectSetupPatchToStored({ sharedTrustHash: '' }), ProjectSetupValidationError);
  });

  test('rejects wrongly shaped patch keys', () => {
    assert.throws(() => projectSetupPatchToStored({ setupWorktree: 'x' }), ProjectSetupValidationError);
    assert.throws(() => projectSetupPatchToStored(null), ProjectSetupValidationError);
    assert.deepEqual(projectSetupPatchToStored({ projectActionsPrimaryId: null }), { projectActionsPrimaryId: undefined });
  });
});

describe('project setup bridge', () => {
  const withStore = async (run: (store: ReturnType<typeof createProjectSetupStore>, dir: string) => Promise<void>) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-project-setup-'));
    try {
      await run(createProjectSetupStore(dir), dir);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  };

  test('stores a project whose id is too long for a file name under a bounded name', async () => {
    await withStore(async (store, dir) => {
      const projectId = projectIdFor(`/private/tmp/${'segment-'.repeat(20)}/demo`);
      assert.ok(projectId.length > 240);
      const stem = projectConfigFileStemOf(projectId);
      assert.ok(stem.startsWith('path_sha256_'));
      assert.ok(stem.length < 100);
      assert.equal(projectConfigFileStemOf('path_short'), 'path_short');

      const view = await store.update(projectId, { setupWorktree: ['bun install'] });
      assert.deepEqual(view.setupWorktree, ['bun install']);
      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, `${stem}.json`), 'utf8'));
      assert.deepEqual(raw['setup-worktree'], ['bun install']);
      assert.deepEqual((await store.read(projectId)).setupWorktree, ['bun install']);
    });
  });

  test('reads a long id from its pre-bound file name and moves it on the next write', async () => {
    await withStore(async (store, dir) => {
      const projectId = `path_${'a'.repeat(200)}`;
      const legacyPath = path.join(dir, `${projectId}.json`);
      const currentPath = path.join(dir, `${projectConfigFileStemOf(projectId)}.json`);
      assert.notEqual(currentPath, legacyPath);
      await fs.promises.writeFile(legacyPath, JSON.stringify({ version: 1, scheduledTasks: [{ id: 'keep' }], 'setup-worktree': ['bun install'] }));

      assert.deepEqual((await store.read(projectId)).setupWorktree, ['bun install']);

      const updated = await store.update(projectId, { projectActions: [{ id: 'a1', name: 'Run', command: 'bun run dev' }] });
      assert.deepEqual(updated.setupWorktree, ['bun install']);
      const raw = JSON.parse(await fs.promises.readFile(currentPath, 'utf8'));
      assert.deepEqual(raw.scheduledTasks, [{ id: 'keep' }]);
      assert.deepEqual(raw['setup-worktree'], ['bun install']);
      assert.equal(raw.projectActions.length, 1);
      await assert.rejects(fs.promises.readFile(legacyPath, 'utf8'), { code: 'ENOENT' });
    });
  });

  test('round-trips a patch through the bridge and preserves foreign keys', async () => {
    await withStore(async (store, dir) => {
      await fs.promises.writeFile(path.join(dir, 'project-a.json'), JSON.stringify({
        version: 1,
        scheduledTasks: [{ id: 'keep' }],
        'setup-worktree': ['old'],
      }));

      const updated = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update', payload: { projectId: 'project-a', patch: { setupWorktree: ['bun install'], projectPath: '/repo' } } },
        store,
      );
      assert.equal(updated?.success, true);
      const view = await store.read('project-a');
      assert.deepEqual(updated?.data, view);
      assert.deepEqual(view.setupWorktree, ['bun install']);
      assert.equal(view.setupWorktreeWait, false);
      assert.equal(view.shared.status, 'invalid');
      assert.equal(view.shared.reason, 'shared-project-config-disabled');

      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'project-a.json'), 'utf8'));
      assert.deepEqual(raw.scheduledTasks, [{ id: 'keep' }]);
      assert.equal(raw.projectPath, '/repo');

      const read = await handleProjectSetupBridgeMessage({ id: '2', type: 'api:project-setup:get', payload: { projectId: 'project-a' } }, store);
      assert.deepEqual(read?.data, updated?.data);
    });
  });

  test('answers a bad patch or project id with a failure, and ignores other messages', async () => {
    await withStore(async (store) => {
      const bad = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update', payload: { projectId: 'project-a', patch: { setupWorktree: 'x' } } },
        store,
      );
      assert.equal(bad?.success, false);
      assert.match(bad?.error ?? '', /setupWorktree must be/);

      const badId = await handleProjectSetupBridgeMessage({ id: '2', type: 'api:project-setup:get', payload: { projectId: '../etc' } }, store);
      assert.equal(badId?.success, false);

      assert.equal(await handleProjectSetupBridgeMessage({ id: '3', type: 'api:fs:read', payload: {} }, store), null);
    });
  });

  test('repository files are undiscovered while personal commands survive even malformed shared config', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      await fs.promises.mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await fs.promises.writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      }));
      const projectId = projectIdFor(repo);
      assert.equal(projectPathFromId(projectId), repo);
      const view = await store.update(projectId, { setupWorktree: ['mine'], hiddenSharedActionIds: ['dev'] });
      assert.equal(view.shared.status, 'invalid');
      assert.equal(view.shared.reason, 'shared-project-config-disabled');
      assert.deepEqual(view.setupWorktree, ['mine']);
      assert.deepEqual(view.projectActions, []);
      await fs.promises.writeFile(path.join(repo, '.openchamber', 'project.json'), '{ broken');
      const broken = await store.read(projectId);
      assert.equal(broken.shared.status, 'invalid');
      assert.deepEqual(broken.setupWorktree, ['mine']);
    });
  });

  test('refuses shared metadata and empty removal through the bridge without changing files or approval', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      await fs.promises.mkdir(repo, { recursive: true });
      const projectId = projectIdFor(repo);
      await fs.promises.mkdir(path.join(repo, '.openchamber'));
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      const bytes = '{ "version": 1, "setupWorktree": ["bun install"], "plansDir": "docs/plans" }\n';
      await fs.promises.writeFile(sharedPath, bytes);
      const shared = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update-shared', payload: { projectId, patch: { plansDir: 'new/plans' } } }, store,
      );
      assert.equal(shared?.success, false);
      assert.equal(shared?.error, 'shared-project-config-writes-disabled');
      const view = await store.read(projectId);
      assert.equal(view.shared.status, 'invalid');
      assert.equal(view.shared.reason, 'shared-project-config-disabled');
      assert.equal(view.shared.plansDir, null);
      assert.equal(view.personal.sharedTrust, null);
      const approved = await handleProjectSetupBridgeMessage(
        { id: 'approve', type: 'api:project-setup:update', payload: { projectId, patch: { sharedTrustHash: 'sha256:explicit-personal-write' } } }, store,
      );
      assert.equal(approved?.success, true);
      assert.equal((await store.read(projectId)).trust.trusted, true);
      const raw = JSON.parse(await fs.promises.readFile(path.join(repo, '.openchamber', 'project.json'), 'utf8'));
      assert.deepEqual(raw, { version: 1, setupWorktree: ['bun install'], plansDir: 'docs/plans' });

      const personalBefore = await fs.promises.readFile(path.join(dir, `${projectConfigFileStemOf(projectId)}.json`), 'utf8');
      await assert.rejects(store.updateShared(projectId, { setupWorktree: [], plansDir: null }), /shared-project-config-writes-disabled/);
      assert.equal(await fs.promises.readFile(sharedPath, 'utf8'), bytes);
      assert.deepEqual(await fs.promises.readdir(path.dirname(sharedPath)), ['project.json']);
      assert.equal(await fs.promises.readFile(path.join(dir, `${projectConfigFileStemOf(projectId)}.json`), 'utf8'), personalBefore);
      assert.equal((await store.read(projectId)).trust.trusted, true);

      const missing = await handleProjectSetupBridgeMessage(
        { id: '2', type: 'api:project-setup:update-shared', payload: { projectId: projectIdFor(path.join(dir, 'nope')), patch: {} } },
        store,
      );
      assert.equal(missing?.success, false);
      assert.equal(missing?.error, 'shared-project-config-writes-disabled');
    });
  });

  test('disabled shared saves never mint approval or change an existing trust timestamp', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      await fs.promises.mkdir(path.dirname(sharedPath), { recursive: true });
      const initial = {
        version: 1, setupWorktree: ['echo unseen'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'echo dev' }],
      };
      await fs.promises.writeFile(sharedPath, JSON.stringify(initial));
      const projectId = projectIdFor(repo);
      const personalPath = path.join(dir, `${projectConfigFileStemOf(projectId)}.json`);
      await fs.promises.writeFile(personalPath, JSON.stringify({
        version: 1, scheduledTasks: [{ id: 'keep' }], futureKey: { keep: true },
        'setup-worktree': ['echo personal'], sharedTrust: { hash: 'sha256:stale', trustedAt: 7 },
      }));
      const originalHash = (await store.read(projectId)).trust.hash;
      for (const patch of [
        { plansDir: 'docs/plans' }, { draftStarters: [{ type: 'skill', name: 's' }] },
        { draftStarters: [] }, {}, { futureKey: true, sharedTrustHash: originalHash },
        { projectActions: [...initial.projectActions, { id: 'mine', name: 'Mine', command: 'echo known-personal' }] },
      ]) {
        const response = await handleProjectSetupBridgeMessage(
          { id: 'save', type: 'api:project-setup:update-shared', payload: { projectId, patch } }, store,
        );
        assert.equal(response?.success, false);
        assert.equal(response?.error, 'shared-project-config-writes-disabled');
        const view = await store.read(projectId);
        assert.equal(view.shared.status, 'invalid');
        assert.equal(view.shared.reason, 'shared-project-config-disabled');
        assert.deepEqual(view.personal.sharedTrust, { hash: 'sha256:stale', trustedAt: 7 });
        assert.deepEqual(view.shared.setupWorktree, []);
        assert.deepEqual(view.shared.projectActions, []);
      }
      const approvedHash = 'sha256:explicit-personal-write';
      const approvalResponse = await handleProjectSetupBridgeMessage(
        { id: 'approve', type: 'api:project-setup:update', payload: { projectId, patch: { sharedTrustHash: approvedHash } } }, store,
      );
      assert.equal(approvalResponse?.success, true);
      const approvedRaw = JSON.parse(await fs.promises.readFile(personalPath, 'utf8'));
      approvedRaw.sharedTrust.trustedAt = 17;
      await fs.promises.writeFile(personalPath, JSON.stringify(approvedRaw));
      const approval = (await store.read(projectId)).personal.sharedTrust;
      assert.ok(approval);
      assert.equal(approval.hash, approvedHash);
      for (const patch of [
        { plansDir: 'other/plans' }, { draftStarters: [{ type: 'command', name: 'explore' }] },
        { draftStarters: [] }, { setupWorktreeWait: true }, {},
        { projectActions: [
          { id: 'dev', name: 'Renamed', icon: 'rocket', command: 'echo dev' },
          { id: 'mine', name: 'Mine', command: 'echo known-personal' },
        ] },
      ]) {
        await assert.rejects(store.updateShared(projectId, patch), /shared-project-config-writes-disabled/);
        const view = await store.read(projectId);
        assert.equal(view.trust.trusted, true);
        assert.deepEqual(view.personal.sharedTrust, approval);
        assert.deepEqual(JSON.parse(await fs.promises.readFile(personalPath, 'utf8')).sharedTrust, approval);
      }
      const personalRaw = JSON.parse(await fs.promises.readFile(personalPath, 'utf8'));
      assert.deepEqual(personalRaw.scheduledTasks, [{ id: 'keep' }]);
      assert.deepEqual(personalRaw.futureKey, { keep: true });
      assert.deepEqual(personalRaw['setup-worktree'], ['echo personal']);
    });
  });

  test('repository changes cannot affect discovery or personal approval; refused saves and serialized personal writes preserve state', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      const sharedPath = path.join(repo, '.openchamber', 'project.json');
      await fs.promises.mkdir(path.dirname(sharedPath), { recursive: true });
      const initial = { version: 1, setupWorktree: ['echo setup'], projectActions: [{ id: 'dev', name: 'Dev', command: 'echo dev' }] };
      const projectId = projectIdFor(repo);
      await store.update('other-project', { sharedTrustHash: 'sha256:other' });
      const other = await store.read('other-project');
      for (const changed of [
        { ...initial, setupWorktree: ['echo changed'] },
        { ...initial, projectActions: [{ ...initial.projectActions[0], runIn: 'parent' }] },
      ]) {
        await fs.promises.writeFile(sharedPath, JSON.stringify(initial));
        const before = await store.read(projectId);
        assert.equal((await store.update(projectId, { sharedTrustHash: 'sha256:explicit-personal-write' })).personal.sharedTrust?.hash, 'sha256:explicit-personal-write');
        const approvalBefore = (await store.read(projectId)).personal.sharedTrust;
        await fs.promises.writeFile(sharedPath, JSON.stringify(changed));
        assert.equal((await store.read(projectId)).shared.status, 'invalid');
        await assert.rejects(store.updateShared(projectId, { plansDir: 'docs/plans' }), /shared-project-config-writes-disabled/);
        const unapproved = await store.read(projectId);
        assert.equal(unapproved.shared.status, 'invalid');
        assert.deepEqual(unapproved.personal.sharedTrust, approvalBefore);
        assert.deepEqual(unapproved.trust, before.trust);
        assert.deepEqual(unapproved.shared.projectActions, []);
      }
      const approved = await store.read(projectId);
      await Promise.all([
        assert.rejects(store.updateShared(projectId, { plansDir: 'new/plans' }), /shared-project-config-writes-disabled/),
        assert.rejects(store.updateShared(projectId, { draftStarters: [{ type: 'skill', name: 's' }] }), /shared-project-config-writes-disabled/),
        store.update(projectId, { setupWorktree: ['echo personal'] }),
        store.update(projectId, { draftStarters: [{ type: 'skill', name: 'personal' }] }),
      ]);
      const current = await store.read(projectId);
      assert.deepEqual(current.personal.sharedTrust, approved.personal.sharedTrust);
      assert.deepEqual(current.personal.setupWorktree, ['echo personal']);
      assert.equal(current.shared.plansDir, null);
      assert.deepEqual(current.shared.draftStarters, []);
      assert.deepEqual(current.personal.draftStarters, [{ type: 'skill', name: 'personal' }]);
      assert.deepEqual(await store.read('other-project'), other);
      await assert.rejects(store.updateShared(projectId, { setupWorktree: 'bad' }), /shared-project-config-writes-disabled/);
      assert.deepEqual(await store.read(projectId), current);
      // A file at the directory path makes the atomic shared write fail before any trust update.
      await fs.promises.rm(path.dirname(sharedPath), { recursive: true });
      await fs.promises.writeFile(path.dirname(sharedPath), 'not a directory');
      const personalPath = path.join(dir, `${projectConfigFileStemOf(projectId)}.json`);
      const personalBefore = await fs.promises.readFile(personalPath, 'utf8');
      await assert.rejects(store.updateShared(projectId, { setupWorktree: ['echo never-approved'] }));
      assert.equal(await fs.promises.readFile(personalPath, 'utf8'), personalBefore);
    });
  });

  for (const layout of ['directory-link', 'dangling-directory-link', 'file-link', 'inside-directory-link', 'regular', 'absent-parent', 'checkout-alias']) {
    test(`shared config confinement at the production bridge: ${layout}`, async () => {
      await withStore(async (store, dir) => {
        const repo = path.join(dir, 'repo');
        const outside = path.join(dir, 'outside');
        await fs.promises.mkdir(repo);
        await fs.promises.mkdir(outside);
        const sentinel = '{ "version": 1, "draftStarters": [{"type":"skill","name":"outside-only"}], "plansDir":"old/plans" }\n';
        const outsidePath = path.join(outside, 'project.json');
        await fs.promises.writeFile(outsidePath, sentinel);
        const configDir = path.join(repo, '.openchamber');
        let checkout = repo;
        if (layout === 'file-link') {
          await fs.promises.mkdir(configDir);
          await fs.promises.symlink(outsidePath, path.join(configDir, 'project.json'));
        } else if (layout === 'inside-directory-link') {
          const child = path.join(repo, 'child');
          await fs.promises.mkdir(child);
          await fs.promises.writeFile(path.join(child, 'project.json'), sentinel);
          await fs.promises.symlink(child, configDir);
        } else if (layout === 'regular' || layout === 'checkout-alias') {
          await fs.promises.mkdir(configDir);
          await fs.promises.writeFile(path.join(configDir, 'project.json'), sentinel);
          if (layout === 'checkout-alias') {
            checkout = path.join(dir, 'alias');
            await fs.promises.symlink(repo, checkout);
          }
        } else if (layout !== 'absent-parent') {
          await fs.promises.symlink(layout === 'directory-link' ? outside : path.join(outside, 'absent'), configDir);
        }
        const projectId = projectIdFor(checkout);
        const personalPath = path.join(dir, `${projectConfigFileStemOf(projectId)}.json`);
        const personalBytes = JSON.stringify({ version: 1, scheduledTasks: [{ id: 'keep' }], futureKey: true, sharedTrust: { hash: 'sha256:old', trustedAt: 17 } });
        await fs.promises.writeFile(personalPath, personalBytes);
        for (const patch of [{ plansDir: 'new/plans' }, { plansDir: null, draftStarters: [] }, {}]) {
          const saved = await handleProjectSetupBridgeMessage({ id: 'save', type: 'api:project-setup:update-shared', payload: { projectId, patch } }, store);
          assert.equal(saved?.success, false);
          assert.equal(saved?.error, 'shared-project-config-writes-disabled');
          assert.equal(await fs.promises.readFile(outsidePath, 'utf8'), sentinel);
          assert.deepEqual(await fs.promises.readdir(outside), ['project.json']);
          assert.equal(await fs.promises.readFile(personalPath, 'utf8'), personalBytes);
        }
        const view = await store.read(projectId);
        assert.equal(view.shared.status, 'invalid');
        assert.equal(view.shared.reason, 'shared-project-config-disabled');
        assert.deepEqual(view.shared.draftStarters, []);
        if (layout === 'regular' || layout === 'checkout-alias') {
          assert.equal(await fs.promises.readFile(path.join(configDir, 'project.json'), 'utf8'), sentinel);
        } else if (layout === 'absent-parent') {
          assert.equal(fs.existsSync(configDir), false);
        }
        const personal = await store.update(projectId, { projectActions: [{ id: 'mine', name: 'Mine', command: 'echo personal' }], draftStarters: [{ type: 'skill', name: 'personal' }] });
        assert.equal(personal.personal.projectActions[0]?.command, 'echo personal');
        assert.deepEqual(personal.personal.sharedTrust, { hash: 'sha256:old', trustedAt: 17 });
        const raw = JSON.parse(await fs.promises.readFile(personalPath, 'utf8'));
        assert.deepEqual(raw.scheduledTasks, [{ id: 'keep' }]);
        assert.equal(raw.futureKey, true);
        assert.equal(await fs.promises.readFile(outsidePath, 'utf8'), sentinel);
      });
    });
  }

  test('the real parent-swap mutation boundary is never reached through the bridge', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      const directory = path.join(repo, '.openchamber');
      const outside = path.join(dir, 'outside');
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.mkdir(outside);
      const bytes = JSON.stringify({ version: 1, plansDir: 'inside/plans' });
      await fs.promises.writeFile(path.join(directory, 'project.json'), bytes);
      await fs.promises.writeFile(path.join(outside, 'project.json'), 'outside sentinel');
      const originalMkdir = fs.promises.mkdir;
      let swaps = 0;
      const mkdir = mock.method(fs.promises, 'mkdir', async (...args: Parameters<typeof fs.promises.mkdir>) => {
        const [target, options] = args;
        if (String(target) === directory) {
          swaps += 1;
          await fs.promises.rename(directory, path.join(repo, 'moved'));
          await fs.promises.symlink(outside, directory);
        }
        return originalMkdir(target, options);
      });
      try {
        const response = await handleProjectSetupBridgeMessage({ id: 'save', type: 'api:project-setup:update-shared', payload: { projectId: projectIdFor(repo), patch: { plansDir: 'new/plans' } } }, store);
        assert.equal(response?.success, false);
        assert.equal(response?.error, 'shared-project-config-writes-disabled');
        assert.equal(swaps, 0);
        assert.equal(mkdir.mock.calls.length, 0);
        assert.equal(await fs.promises.readFile(path.join(directory, 'project.json'), 'utf8'), bytes);
        assert.equal(await fs.promises.readFile(path.join(outside, 'project.json'), 'utf8'), 'outside sentinel');
      } finally {
        mkdir.mock.restore();
      }
    });
  });

  test('shared reads use only personal storage and no checkout path or descriptor', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      await fs.promises.mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await fs.promises.writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({ version: 1, setupWorktree: ['echo repository-only'] }));
      const projectId = projectIdFor(repo);
      const personalPath = path.join(dir, `${projectConfigFileStemOf(projectId)}.json`);
      const reads = mock.method(fs.promises, 'readFile');
      const opens = mock.method(fs.promises, 'open');
      const stats = mock.method(fs.promises, 'stat');
      const realpaths = mock.method(fs.promises, 'realpath');
      const readlinks = mock.method(fs.promises, 'readlink');
      try {
        const response = await handleProjectSetupBridgeMessage({ id: 'read', type: 'api:project-setup:get', payload: { projectId } }, store);
        assert.equal(response?.success, true);
        const view = await store.read(projectId);
        assert.equal(view.shared.status, 'invalid');
        assert.equal(view.shared.reason, 'shared-project-config-disabled');
        assert.deepEqual(view.setupWorktree, []);
        assert.equal(JSON.stringify(view).includes(repo), false);
        assert.deepEqual(reads.mock.calls.map((call) => String(call.arguments[0])), [personalPath, personalPath]);
        for (const operation of [opens, stats, realpaths, readlinks]) assert.equal(operation.mock.calls.length, 0);
      } finally {
        reads.mock.restore(); opens.mock.restore(); stats.mock.restore(); realpaths.mock.restore(); readlinks.mock.restore();
      }
    });
  });

  test('shared config remains disabled for a canonical checkout alias and all leaf states', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      const directory = path.join(repo, '.openchamber');
      await fs.promises.mkdir(directory, { recursive: true });
      const alias = path.join(dir, 'alias');
      await fs.promises.symlink(repo, alias);
      const projectId = projectIdFor(alias);
      assert.equal((await store.read(projectId)).shared.status, 'invalid');
      const sharedPath = path.join(directory, 'project.json');
      await fs.promises.mkdir(sharedPath);
      assert.equal((await store.read(projectId)).shared.status, 'invalid');
      await fs.promises.rm(sharedPath, { recursive: true });
      await fs.promises.writeFile(sharedPath, JSON.stringify({ version: 1, setupWorktree: ['echo safe'] }));
      const view = await store.read(projectId);
      assert.equal(view.shared.status, 'invalid');
      assert.equal(view.shared.reason, 'shared-project-config-disabled');
      assert.deepEqual(view.setupWorktree, []);
      const personal = await store.update(projectId, { setupWorktree: ['echo personal'], sharedTrustHash: 'sha256:explicit-personal-write' });
      assert.deepEqual(personal.setupWorktree, ['echo personal']);
      assert.equal(personal.personal.sharedTrust?.hash, 'sha256:explicit-personal-write');
    });
  });

  test('shared writes refuse before any personal or checkout filesystem operation', async () => {
    await withStore(async (store, dir) => {
      const originalReadFile = fs.promises.readFile;
      const originalMkdir = fs.promises.mkdir;
      const originalStat = fs.promises.stat;
      const originalOpen = fs.promises.open;
      let calls = 0;
      const refuse = async (): Promise<never> => { calls += 1; throw new Error('unexpected filesystem operation'); };
      fs.promises.readFile = refuse;
      fs.promises.mkdir = refuse;
      fs.promises.stat = refuse;
      fs.promises.open = refuse;
      try {
        for (const projectId of [projectIdFor(path.join(dir, 'repo')), 'project-a', '../invalid']) {
          await assert.rejects(store.updateShared(projectId, {}), /shared-project-config-writes-disabled/);
        }
        const response = await handleProjectSetupBridgeMessage({ id: 'save', type: 'api:project-setup:update-shared', payload: { projectId: 'project-a', patch: {} } }, store);
        assert.equal(response?.error, 'shared-project-config-writes-disabled');
        assert.equal(calls, 0);
      } finally {
        fs.promises.readFile = originalReadFile;
        fs.promises.mkdir = originalMkdir;
        fs.promises.stat = originalStat;
        fs.promises.open = originalOpen;
      }
    });
  });

  test('serializes two quick updates to one file', async () => {
    await withStore(async (store, dir) => {
      await Promise.all([
        store.update('project-a', { setupWorktree: ['a'] }),
        store.update('project-a', { draftStarters: [{ type: 'skill', name: 's' }] }),
      ]);
      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'project-a.json'), 'utf8'));
      assert.deepEqual(raw['setup-worktree'], ['a']);
      assert.deepEqual(raw.draftStarters, [{ type: 'skill', name: 's' }]);
    });
  });
});
