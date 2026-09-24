import { describe, expect, test } from 'bun:test';
import type { SessionGroup } from '../types';
import { splitSectionsByWorkspace } from './workspaceSections';

const group = (id: string, label: string, extra: Partial<SessionGroup> = {}): SessionGroup => ({ id, label, branch: null,
  description: null, isMain: false, isArchivedBucket: false, worktree: null, directory: '/p/smarty-dev', folderScopeKey: '/p/smarty-dev', sessions: [], ...extra });
const project = { id: 'dev', normalizedPath: '/p/smarty-dev' };

// Org's live rule (2026-09-24): smarty-org and smarty-dev share the smarty-dev checkout; the sidebar shows TWO
// top-level groups, and the linked worktrees nest under smarty-dev (the workspace named for the folder).
describe('top-level sections per Herdr workspace', () => {
  test('a shared checkout becomes one top-level item per workspace; worktrees go to the folder-named one', () => {
    const groups = [group('workspace:wA9', 'smarty-org', { isMain: true, workspaceId: 'wA9' }),
      group('workspace:w2', 'smarty-dev', { isMain: true, workspaceId: 'w2' }), group('worktree:/wt', 'ci-delivery', { directory: '/wt' })];
    const items = splitSectionsByWorkspace([{ project, groups }]);
    expect(items.map((item) => [item.key, item.label, item.section.groups.map((g) => g.label)])).toEqual([
      ['dev::workspace:wA9', 'smarty-org', ['smarty-org']],
      ['dev', 'smarty-dev', ['smarty-dev', 'ci-delivery']],
    ]);
    // Each workspace's sessions render as the plain root of its own item.
    expect(items.every((item) => item.split && item.section.groups[0]!.isMain && !item.section.groups[0]!.workspaceId)).toBe(true);
  });
  test('an unshared project renders unchanged under its own id', () => {
    const sections = [{ project, groups: [group('root', 'x', { isMain: true })] }];
    expect(splitSectionsByWorkspace(sections)).toEqual([{ key: 'dev', section: sections[0], split: false }]);
  });
});
