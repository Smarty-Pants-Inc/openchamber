import { describe, expect, test } from 'bun:test';
import { managedActiveProject, managedProjectView, readManagedCatalog } from './managed-project-catalog';

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
    expect(view[0]).toEqual(bookmarks[0]);
    expect(view[0]).not.toBe(bookmarks[0]);
    expect(view[1]?.id).not.toBe(b.id);
    expect(managedProjectView([a], bookmarks)[0]?.label).toBe('My A');
  });
  test('retired active selection falls back to live member, then null', () => {
    const view = managedProjectView([b], bookmarks);
    expect(managedActiveProject(view, 'saved-a')).toBe(view[0]?.id ?? null);
    expect(managedActiveProject(view, view[0]?.id ?? null)).toBe(view[0]?.id ?? null);
    expect(managedActiveProject([], 'saved-a')).toBeNull();
  });
});
