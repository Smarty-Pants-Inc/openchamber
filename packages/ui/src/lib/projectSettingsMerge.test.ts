import { expect, test } from 'bun:test';
import { mergeProjectSettings } from './projectSettingsMerge';

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
