import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup } from '../types';
import { splitRootGroupByWorkspace } from './workspaceGroups';

const session = (id: string, workspaceID?: string) => ({ session: { id, directory: '/p/dev', ...(workspaceID ? { workspaceID } : {}) } as unknown as Session, children: [], worktree: null });
const root: SessionGroup = { id: 'root', label: 'smarty-dev · smarty-org', branch: 'main', description: null, isMain: true, isArchivedBucket: false,
  worktree: null, directory: '/p/dev', folderScopeKey: '/p/dev', sessions: [session('dev-lead', 'w2'), session('org', 'wA9'), session('legacy')] };
const worktree: SessionGroup = { ...root, id: 'worktree:/p/dev/wt', label: 'ci-delivery', isMain: false, directory: '/p/dev/wt', sessions: [session('ci', 'w4N')] };

// smarty-code#126 (org's live review): one labelled group per Herdr workspace; a shared checkout is two groups.
describe('workspace groups for a shared checkout', () => {
  test('split the root group into one labelled group per workspace, in Herdr order', () => {
    const groups = splitRootGroupByWorkspace([root, worktree], [{ id: 'w2', label: 'smarty-dev' }, { id: 'wA9', label: 'smarty-org' }]);
    expect(groups.map((group) => [group.label, group.sessions.map((node) => node.session.id)])).toEqual([
      ['smarty-dev', ['dev-lead', 'legacy']],
      ['smarty-org', ['org']],
      ['ci-delivery', ['ci']],
    ]);
    expect(groups.slice(0, 2).every((group) => !group.isMain && group.directory === '/p/dev')).toBe(true);
  });
  test('a single-workspace project keeps its root group', () => {
    const groups = [root, worktree];
    expect(splitRootGroupByWorkspace(groups, [{ id: 'w2', label: 'smarty-dev' }])).toBe(groups);
    expect(splitRootGroupByWorkspace(groups, undefined)).toBe(groups);
  });
});
