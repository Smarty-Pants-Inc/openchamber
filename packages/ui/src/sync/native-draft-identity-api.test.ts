// UNRUN on baseline: these test the fixed new shared export after owner implementation.
import { expect, test } from 'bun:test';
import { resolveDraftProjectDirectory } from './native-draft-identity';

const project = { id: 'bookmark-opaque', path: '/accepted/org' };
for (const override of [null, '', '/worktrees/org/topic']) {
  test(`explicit policy preserves raw override ${JSON.stringify(override)}`, () => {
    expect(resolveDraftProjectDirectory({ selectedProjectId: project.id, directoryOverride: override }, [project], 'explicit'))
      .toEqual({ project, directory: override });
  });
  test(`project policy uses only nullish fallback ${JSON.stringify(override)}`, () => {
    expect(resolveDraftProjectDirectory({ selectedProjectId: project.id, directoryOverride: override }, [project], 'project'))
      .toEqual({ project, directory: override ?? project.path });
  });
}

test('lookup is exact applied selected ID, never inferred from labels or paths', () => {
  const other = { id: 'other', path: '/different/org', label: 'org (Paul)' };
  expect(resolveDraftProjectDirectory({ selectedProjectId: project.id, directoryOverride: '/raw' }, [other, project], 'explicit'))
    .toEqual({ project, directory: '/raw' });
  expect(resolveDraftProjectDirectory({ selectedProjectId: project.path, directoryOverride: null }, [project], 'project'))
    .toEqual({ project: undefined, directory: undefined });
  expect(resolveDraftProjectDirectory({ selectedProjectId: project.id, directoryOverride: '/raw' }, [], 'explicit'))
    .toEqual({ project: undefined, directory: '/raw' });
});

test('explicit policy never evaluates path, project policy evaluates it eagerly once', () => {
  let reads = 0;
  const guarded = { id: project.id, get path() { reads++; return project.path; } };
  const projects = Object.freeze([guarded]);
  const draft = Object.freeze({ selectedProjectId: project.id, directoryOverride: '/raw' });
  const explicit = resolveDraftProjectDirectory(draft, projects, 'explicit');
  expect(explicit.project).toBe(guarded); expect(explicit.directory).toBe('/raw'); expect(reads).toBe(0);
  const result = resolveDraftProjectDirectory(draft, projects, 'project');
  expect(result.project).toBe(guarded); expect(result.directory).toBe('/raw'); expect(reads).toBe(1);
});
