import { describe, expect, test } from 'bun:test';
import { managedActiveProject, managedProjectView, nestManagedProjects, readManagedCatalog } from './managed-project-catalog';

const reply = (marked = true, status = 200) => new Response(null, {
  status, headers: marked ? { 'X-Smarty-Code-Catalog': 'managed-v1' } : {},
});
const a = { id: 'gateway-a', worktree: '/allowed/a', name: 'A' };
const b = { id: 'gateway-b', worktree: '/allowed/b' };
const bookmarks = [
  { id: 'saved-a', path: '/allowed/a', label: 'My A', addedAt: 1, lastOpenedAt: 2 },
  { id: 'outside', path: '/outside', label: 'Private bookmark', addedAt: 3, lastOpenedAt: 4 },
];

describe('managed project authority, not bookmark admission', () => {
  test('stock remains stock until explicitly marked, including unmarked empty', () => {
    expect(readManagedCatalog(reply(false), [], false)).toBeNull();
    expect(readManagedCatalog(reply(false), [a], false)).toBeNull();
  });
  test('marked empty is authoritative; errors and lost marker are not empty', () => {
    expect(readManagedCatalog(reply(), [], true)).toEqual([]);
    expect(() => readManagedCatalog(reply(false), [], true)).toThrow();
    expect(() => readManagedCatalog(reply(true, 503), [], true)).toThrow();
    expect(() => readManagedCatalog(reply(true, 401), [], false)).toThrow();
  });
  test('reject malformed/duplicate membership without partial publication', () => {
    for (const invalid of [null, {}, [a, a], [{ ...a, worktree: '../a' }], [a, { ...b, id: a.id }]]) {
      expect(() => readManagedCatalog(reply(), invalid, true)).toThrow();
    }
  });
  test('reload while A absent never promotes saved A or outside bookmark', () => {
    const before = structuredClone(bookmarks);
    const view = managedProjectView([b], bookmarks);
    expect(view.map(p => p.path)).toEqual(['/allowed/b']);
    expect(bookmarks).toEqual(before);
    expect(managedProjectView([], bookmarks)).toEqual([]);
  });
  test('metadata overlays live membership and return reuses bookmark identity', () => {
    const view = managedProjectView([a, b], bookmarks);
    // Bookmark identity and metadata are kept; the catalog name (the Herdr label) is shown as-is.
    expect(view[0]).toEqual({ ...bookmarks[0], label: 'A' });
    expect(view[0]).not.toBe(bookmarks[0]);
    expect(view[1]?.id).not.toBe(b.id);
    expect(managedProjectView([b], [{ id: 'saved-b', path: '/allowed/b', label: 'My B' }])[0]?.label).toBe('My B');
  });
  test('retired active selection falls back to live member, then null', () => {
    const view = managedProjectView([b], bookmarks);
    expect(managedActiveProject(view, 'saved-a')).toBe(view[0]?.id ?? null);
    expect(managedActiveProject(view, view[0]?.id ?? null)).toBe(view[0]?.id ?? null);
    expect(managedActiveProject([], 'saved-a')).toBeNull();
  });
});

// smarty-code#126 grouping parity: mirror Herdr's tree (root -> linked worktree workspaces).
describe('managed-v1 nesting', () => {
  const root = { id: 'r', worktree: '/p/herdr', name: 'Herdr', workspaces: [{ id: 'w4H', label: 'Herdr' }] };
  const child = { id: 'c', worktree: '/p/herdr/worktrees/upstream-0.9', name: 'herdr-upstream-0.9', parent: '/p/herdr' };
  const orphan = { id: 'o', worktree: '/p/other', name: 'other', parent: '/p/missing' };
  test('parses the grouping fields and keeps parent only for a published root', () => {
    const parsed = readManagedCatalog(reply(), [root, child, orphan], true)!;
    const view = managedProjectView(parsed, []);
    expect(view.map(p => [p.label, p.parent])).toEqual([['Herdr', undefined], ['herdr-upstream-0.9', '/p/herdr'], ['other', undefined]]);
    expect(view[0]?.workspaces).toEqual([{ id: 'w4H', label: 'Herdr' }]);
  });
  test('linked worktrees render as worktree groups of their root, not top-level projects', () => {
    const view = managedProjectView([root, child], []);
    const discovered = new Map([['/p/herdr', [{ path: '/p/herdr/worktrees/upstream-0.9', projectDirectory: '/p/herdr', branch: 'upstream-0.9', label: 'upstream-0.9' }]]]);
    const nested = nestManagedProjects(view, discovered);
    expect(nested.topLevel.map(p => p.path)).toEqual(['/p/herdr']);
    expect(nested.worktreesByProject.get('/p/herdr')).toEqual([
      { path: '/p/herdr/worktrees/upstream-0.9', projectDirectory: '/p/herdr', branch: 'upstream-0.9', label: 'herdr-upstream-0.9' },
    ]);
    expect(discovered.get('/p/herdr')![0]!.label).toBe('upstream-0.9');
    expect(nestManagedProjects(managedProjectView([root], []), new Map()).topLevel).toHaveLength(1);
  });
});
