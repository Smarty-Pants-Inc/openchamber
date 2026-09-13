import { expect, test } from 'bun:test';
import { ok, rejects } from 'node:assert/strict';
import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from './api/types';
import { mergeProjectSettings, saveProjectSettings, SettingsConflictError } from './projectSettingsMerge';

const a = { id: 'a', path: '/a', label: 'A' };
const b = { id: 'b', path: '/b', label: 'B' };
const c = { id: 'c', path: '/c', label: 'C' };

test('preserves independent additions and changes from the server', () => {
  expect(mergeProjectSettings([], [b], [a])).toEqual([b, a]);
  expect(mergeProjectSettings([a], [{ ...a, label: 'Server' }], [a, b]))
    .toEqual([{ ...a, label: 'Server' }, b]);
});

test('rejects conflicting edits or a delete against a changed project', () => {
  expect(() => mergeProjectSettings([a], [{ ...a, label: 'Server' }], [{ ...a, label: 'Client' }])).toThrow('Projects changed');
  expect(() => mergeProjectSettings([a], [{ ...a, label: 'Server' }], [])).toThrow('Projects changed');
  expect(() => mergeProjectSettings([a], [], [{ ...a, label: 'Client' }])).toThrow('Projects changed');
});

test('accepts explicit deletes and does not restore server-deleted unchanged entries', () => {
  expect(mergeProjectSettings([a, b], [a, b], [a])).toEqual([a]);
  expect(mergeProjectSettings([a, b], [a], [a, b, c])).toEqual([a, c]);
});

test('preserves independent reorders and rejects incompatible concurrent reorders', () => {
  expect(mergeProjectSettings([a, b], [a, b, c], [b, a])).toEqual([b, a, c]);
  expect(mergeProjectSettings([a, b], [b, a], [a, b, c])).toEqual([b, a, c]);
  expect(() => mergeProjectSettings([a, b, c], [b, a, c], [a, c, b])).toThrow('Project order changed');
});

test('compares JSON values independent of key order and rejects duplicate IDs', () => {
  expect(mergeProjectSettings([a], [{ label: 'A', path: '/a', id: 'a' }], [])).toEqual([]);
  expect(() => mergeProjectSettings([], [a, a], [])).toThrow('Duplicate project IDs');
});

const initial: SettingsPayload = { projects: [a], activeProjectId: a.id, lastDirectory: a.path };
const desired = { projects: [a, b], activeProjectId: b.id, lastDirectory: b.path };
const fresh: SettingsLoadResult = { settings: { ...initial, pwaAppName: 'Concurrent' }, source: 'web', revision: '"fresh"' };
const conflictFixture = (next = fresh, error = new SettingsConflictError('Rejected (412)')) => {
  let loads = 0;
  const conditions: Array<string | undefined> = [];
  const original: SettingsLoadResult = { settings: initial, source: 'web', revision: '"initial"' };
  const api: SettingsAPI = {
    async load() {
      loads += 1;
      return structuredClone(loads === 1 ? original : next);
    },
    async save(changes, options) {
      conditions.push(options?.ifMatch);
      if (conditions.length === 1) throw error;
      return changes;
    },
  };
  return { api, conditions, error, get loads() { return loads; } };
};

test('recovers only the same patch after a fresh unrelated change, independent of nested key order', async () => {
  const f = conflictFixture({ ...fresh, settings: { ...fresh.settings, projects: [{ label: 'A', path: '/a', id: 'a' }] } });
  const result = await saveProjectSettings(f.api, desired, [a], () => true, () => true);
  expect(result).toEqual(desired);
  ok(result && !('pwaAppName' in result));
  expect(f.conditions).toEqual(['"initial"', '"fresh"']);
  expect(f.loads).toBe(2);
});

const conflicts: Array<{ name: string; snapshot: SettingsLoadResult }> = [
  { name: 'authoritative project deletion', snapshot: { ...fresh, settings: { ...initial, projects: [] } } },
  { name: 'project entry change', snapshot: { ...fresh, settings: { ...initial, projects: [{ ...a, label: 'Remote' }] } } },
  { name: 'active project change', snapshot: { ...fresh, settings: { ...initial, activeProjectId: c.id } } },
  { name: 'directory change', snapshot: { ...fresh, settings: { ...initial, lastDirectory: c.path } } },
  { name: 'missing revision', snapshot: { ...fresh, revision: undefined } },
  { name: 'stale revision', snapshot: { ...fresh, revision: '"initial"' } },
];
for (const { name, snapshot } of conflicts) test(`does not recover over ${name}`, async () => {
  const f = conflictFixture(snapshot);
  await rejects(saveProjectSettings(f.api, desired, [a], () => true, () => true), error => error === f.error);
  expect(f.conditions).toEqual(['"initial"']);
  expect(f.loads).toBe(2);
});

test('a coalesced preference in the project patch is also protected from overwrite', async () => {
  const f = conflictFixture({ ...fresh, settings: { ...fresh.settings, terminalShell: 'fish' } });
  await rejects(saveProjectSettings(f.api, { ...desired, terminalShell: 'bash' }, [a],
    () => true, () => true), error => error === f.error);
  expect(f.conditions).toEqual(['"initial"']);
});

test('a second definite conflict is terminal', async () => {
  const f = conflictFixture();
  const second = new SettingsConflictError('Second rejection (412)');
  const save = f.api.save;
  f.api.save = async (changes, options) => { await save(changes, options); throw second; };
  await rejects(saveProjectSettings(f.api, desired, [a], () => true, () => true), error => error === second);
  expect(f.conditions).toEqual(['"initial"', '"fresh"']);
  expect(f.loads).toBe(2);
});

test('an uncertain failure cannot use recovery, even with conflict-like text', async () => {
  const f = conflictFixture(fresh, new Error('Rejected (412)'));
  await rejects(saveProjectSettings(f.api, desired, [a], () => true, () => true), error => error === f.error);
  expect(f.conditions).toEqual(['"initial"']);
  expect(f.loads).toBe(1);
});

test('a failed recovery read cannot become a save or empty success', async () => {
  const f = conflictFixture();
  const failure = new Error('Read failed');
  const load = f.api.load;
  f.api.load = async () => { if (f.conditions.length) throw failure; return load(); };
  await rejects(saveProjectSettings(f.api, desired, [a], () => true, () => true), error => error === failure);
  expect(f.conditions).toEqual(['"initial"']);
});

for (const afterRead of [false, true]) test(`newer local intent stops recovery afterRead=${afterRead}`, async () => {
  const f = conflictFixture();
  await rejects(saveProjectSettings(f.api, desired, [a], () => true,
    () => afterRead && f.loads < 2), error => error === f.error);
  expect(f.conditions).toEqual(['"initial"']);
  expect(f.loads).toBe(afterRead ? 2 : 1);
});

test('a runtime change during the recovery read cancels without another write', async () => {
  const f = conflictFixture();
  expect(await saveProjectSettings(f.api, desired, [a], () => f.loads < 2, () => true)).toBeNull();
  expect(f.conditions).toEqual(['"initial"']);
});
