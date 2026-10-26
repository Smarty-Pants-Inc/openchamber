import { describe, expect, test } from 'bun:test';
import { changedFileTotal } from './changedFileTotal';

// openchamber#649 review P1-1: "Commit and switch" commits every change (git add .) and stash includes untracked files,
// so the count beside them includes the untracked files the server counted but did not list.
describe('changedFileTotal', () => {
  const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, index: '?', working_dir: '?' }));
  test('listed files plus the untracked files past the listing cap', () => {
    expect(changedFileTotal({ files, untrackedOmitted: 10_738 })).toBe(10_939);
  });
  test('no omitted count: the listed files', () => {
    expect(changedFileTotal({ files })).toBe(201);
  });
  test('no status: zero', () => {
    expect(changedFileTotal(null)).toBe(0);
    expect(changedFileTotal(undefined)).toBe(0);
  });
});
