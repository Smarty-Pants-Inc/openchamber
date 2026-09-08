import { describe, expect, test } from 'bun:test';
import { buildKnownSessionDirectories } from './sessionListDirectories';

describe('buildKnownSessionDirectories', () => {
  test('normalizes project roots and optionally includes worktrees', () => {
    const worktrees = new Map([
      ['/repo', [{ path: '/repo/worktree', projectDirectory: '/repo', branch: 'worktree', label: 'worktree' }]],
    ]);

    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees)]).toEqual([
      '/Repo',
      '/repo/worktree',
    ]);
    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees, { includeWorktrees: false })]).toEqual([
      '/Repo',
    ]);
  });

  test('retains case-distinct roots and worktrees for directory requests', () => {
    const worktrees = new Map([
      ['/Repo', [{ path: '/Repo/Feature/', projectDirectory: '/Repo', branch: 'feature', label: 'feature' }]],
    ]);
    expect([...buildKnownSessionDirectories([
      { path: '/Repo/' }, { path: '/repo' }, { path: '/Repo' },
    ], worktrees)]).toEqual(['/Repo', '/repo', '/Repo/Feature']);
  });

  test('normalizes Windows separators and drive letters without changing folder case', () => {
    expect([...buildKnownSessionDirectories([{ path: 'c:\\Users\\Paul\\Project\\' }], new Map())])
      .toEqual(['C:/Users/Paul/Project']);
  });
});
