import { describe, expect, test } from 'bun:test';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { showsActivitySections, showsChatGroup } from './chatGroupVisibility';

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
  test('Smarty Code shows no "chats" or "recent" sections, not even before the catalog is known (smarty-code#126)', () => {
    for (const catalogStatus of ['unknown', 'ready', 'unavailable']) {
      expect(showsActivitySections({ isVSCode: false, managedCatalog: true, catalogStatus })).toBe(false);
    }
    expect(showsActivitySections({ isVSCode: false, managedCatalog: false, catalogStatus: 'unknown' })).toBe(false);
    // Stock keeps them, also when a later refresh fails.
    for (const catalogStatus of ['stock', 'unavailable']) {
      expect(showsActivitySections({ isVSCode: false, managedCatalog: false, catalogStatus })).toBe(true);
    }
    expect(showsActivitySections({ isVSCode: true, managedCatalog: false, catalogStatus: 'stock' })).toBe(false);
  });
});
