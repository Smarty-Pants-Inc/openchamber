import { describe, expect, test } from 'bun:test';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { nextStockConfirmed, showsActivitySections, showsChatGroup } from './chatGroupVisibility';

describe('SessionProjectCollection', () => {
  test('preserves authoritative background demand when its visible rows are absent', () => {
    const demands = buildSessionBootstrapDemands({
      knownDirectories: ['/project', '/project/worktree'],
      activeProjectDirectory: '/project',
      activeProjectId: 'project',
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    });

    expect(demands.map((demand) => demand.directory)).toEqual(['/project', '/project/worktree']);
    expect(demands[0]?.priority).toBe('active-project');
    expect(demands[1]?.priority).toBe('background');
  });

  // Sidebar audit 2026-09-23: the managed catalog admits no Chat target; its empty "chats" block
  // sat above the fleet's projects. Stock and chats-present cases keep the group.
  test('hides the empty chats group under a managed catalog only', () => {
    expect(showsChatGroup({ isVSCode: false, managedCatalog: true, chatSessionCount: 0 })).toBe(false);
    expect(showsChatGroup({ isVSCode: false, managedCatalog: true, chatSessionCount: 2 })).toBe(true);
    expect(showsChatGroup({ isVSCode: false, managedCatalog: false, chatSessionCount: 0 })).toBe(true);
    expect(showsChatGroup({ isVSCode: true, managedCatalog: false, chatSessionCount: 3 })).toBe(false);
  });
  test('Smarty Code shows no "chats" or "recent" sections at any point; stock shows them once it answers (smarty-code#126)', () => {
    const shown = (steps: [managedCatalog: boolean, catalogStatus: string][]) => {
      let confirmed = false;
      return steps.map(([managedCatalog, catalogStatus]) => {
        confirmed = nextStockConfirmed(confirmed, { managedCatalog, catalogStatus });
        return showsActivitySections({ isVSCode: false, stockConfirmed: confirmed });
      });
    };
    // Managed: the first discovery fails before the marker, then a later managed answer succeeds (code-lead, OC#169).
    expect(shown([[false, 'unknown'], [false, 'unavailable'], [true, 'unknown'], [true, 'ready'], [true, 'unavailable']]))
      .toEqual([false, false, false, false, false]);
    // Stock: hidden until it answers, then kept when a later refresh fails.
    expect(shown([[false, 'unknown'], [false, 'stock'], [false, 'unavailable'], [false, 'stock']])).toEqual([false, true, true, true]);
    expect(showsActivitySections({ isVSCode: true, stockConfirmed: true })).toBe(false);
  });
});
