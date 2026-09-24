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
    // Still root groups: not worktrees (no PR polling or extra bootstrap), labelled by their workspace.
    expect(groups.slice(0, 2).map((group) => [group.isMain, group.workspaceId, group.directory])).toEqual([[true, 'w2', '/p/dev'], [true, 'wA9', '/p/dev']]);
    // Folders stay with the first workspace group only.
    expect(groups[0]!.folderScopeKey).toBe('/p/dev');
    expect(groups[1]!.folderScopeKey).not.toBe('/p/dev');
  });
  test('a single-workspace project keeps its root group', () => {
    const groups = [root, worktree];
    expect(splitRootGroupByWorkspace(groups, [{ id: 'w2', label: 'smarty-dev' }])).toBe(groups);
    expect(splitRootGroupByWorkspace(groups, undefined)).toBe(groups);
  });
});

describe('render descriptors for workspace groups', () => {
  test('all workspace groups render as labelled roots, in both full and main-only views', async () => {
    const { buildGroupRenderDescriptors } = await import('./sessionProjectRender');
    const groups = splitRootGroupByWorkspace([root, worktree], [{ id: 'w2', label: 'smarty-dev' }, { id: 'wA9', label: 'smarty-org' }]);
    // SAFETY: the builder reads only project.id from the section's project.
    const section = { project: { id: 'dev' }, groups } as unknown as Parameters<typeof buildGroupRenderDescriptors>[0];
    const full = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false });
    expect(full.map((d) => [d.group.label, d.hideGroupLabel])).toEqual([['smarty-dev', false], ['smarty-org', false], ['ci-delivery', false]]);
    const mainOnly = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: true });
    expect(mainOnly.map((d) => d.group.label)).toEqual(['smarty-dev', 'smarty-org']);
  });
});
