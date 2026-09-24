import { describe, expect, test } from 'bun:test';
import type { SessionGroup } from '../types';
import { nestSharedCheckout } from './workspaceSections';

const group = (id: string, label: string, extra: Partial<SessionGroup> = {}): SessionGroup => ({ id, label, branch: null,
  description: null, isMain: false, isArchivedBucket: false, worktree: null, directory: '/p/smarty-dev', folderScopeKey: '/p/smarty-dev', sessions: [], ...extra });
const project = { id: 'dev', normalizedPath: '/p/smarty-dev' };

// Herdr's workspace_entries (#126 5809353823): smarty-org (first in Herdr order) heads the block; smarty-dev and
// every linked worktree are its children, in Herdr order.
describe('Herdr block nesting for a shared checkout', () => {
  test('the first workspace heads the block; the other workspace and the worktrees are its children', () => {
    const groups = [group('workspace:wA9', 'smarty-org', { isMain: true, workspaceId: 'wA9' }),
      group('workspace:w2', 'smarty-dev', { isMain: true, workspaceId: 'w2' }), group('worktree:/wt', 'ci-delivery', { directory: '/wt' })];
    const [item, ...more] = nestSharedCheckout([{ project, groups }]);
    expect(more).toEqual([]);
    expect([item!.key, item!.label]).toEqual(['dev', 'smarty-org']);
    // The head's sessions are the header's own rows (no label); smarty-dev stays a labelled child, then the worktree.
    expect(item!.section.groups.map((g) => [g.label, g.isMain, g.workspaceId ?? null])).toEqual([
      ['smarty-org', true, null], ['smarty-dev', true, 'w2'], ['ci-delivery', false, null]]);
  });
  test('an unshared project renders unchanged under its own label', () => {
    const sections = [{ project, groups: [group('root', 'x', { isMain: true })] }];
    expect(nestSharedCheckout(sections)).toEqual([{ key: 'dev', section: sections[0] }]);
  });
});
