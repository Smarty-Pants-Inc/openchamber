import { describe, expect, test } from 'bun:test';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { buildKnownSessionDirectories } from './sessionListDirectories';
import { buildSidebarSessionProjection } from './sessionCollection';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildSessionSidebarRowModel } from '../sessionSidebarRowModel';
import type { SessionGroup } from '../types';
import { showsActivitySections, showsChatGroup } from './chatGroupVisibility';
import { nextStockConfirmed } from '@/lib/stock-confirmation';

describe('SessionProjectCollection', () => {
  test('86 available stock directories keep every known session visible while only working directories bootstrap', () => {
    const projects = Array.from({ length: 43 }, (_, index) => ({ id: `project-${index}`, path: `/fleet/p${index}` }));
    const worktrees = new Map(projects.map((project) => [project.path, [{
      path: `${project.path}/worktree`, projectDirectory: project.path, branch: 'feature', label: 'feature',
    }]]));
    const knownDirectories = buildKnownSessionDirectories(projects, worktrees);
    expect(knownDirectories.size).toBe(86);
    const globalActiveSessions: Session[] = [...knownDirectories].map((directory, index) => ({
      id: `ses_${index}`, slug: `session-${index}`, title: `Session ${index}`, version: '1',
      projectID: projects[Math.floor(index / 2)]!.id, directory, time: { created: index, updated: index },
    }));
    const input = {
      knownDirectories,
      activeProjectDirectory: projects[0]!.path,
      activeProjectId: projects[0]!.id,
      collapsedProjects: new Set<string>(),
      collapsedGroups: new Set<string>(),
      currentDirectory: projects[0]!.path,
      currentSessionDirectory: `${projects[7]!.path}/worktree`,
    };
    expect(buildSessionBootstrapDemands(input).map((demand) => [demand.directory, demand.priority]))
      .toEqual([['/fleet/p0', 'selected'], ['/fleet/p7/worktree', 'selected']]);
    const projection = buildSidebarSessionProjection({
      globalActiveSessions, liveSessions: [], knownDirectories, isVSCode: false,
      pinnedSessionIds: new Set(), sessionOrderRanks: new Map(),
    });
    expect(projection.projectSessions).toEqual(globalActiveSessions);
    expect(projection.sessionById.size).toBe(86);
    const sections = projects.map((project) => ({
      project: { ...project, normalizedPath: project.path },
      groups: [project.path, `${project.path}/worktree`].map((directory, index): SessionGroup => ({
        id: directory, label: directory, branch: index ? 'feature' : null, description: null,
        isMain: index === 0, worktree: null, directory,
        sessions: projection.projectSessions.filter((session) => session.directory === directory)
          .map((session) => ({ session, children: [], worktree: null })),
      })),
    }));
    const rows = buildSessionSidebarRowModel({
      mode: 'normal', sections, authoritativeSections: sections, chatGroup: null, recentSections: [], showRecentSection: false,
      foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '', collapsedProjects: new Set(), collapsedGroups: new Set(),
      collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(), visibleCountByContainer: new Map(),
      pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey: new Map(), folderAuthorityByOwner: new Map(),
      activeProjectId: projects[0]!.id, singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
    });
    expect(rows.rows.flatMap((row) => row.kind === 'session' ? [row.node.session.id] : []).sort())
      .toEqual(globalActiveSessions.map((session) => session.id).sort());
    expect(rows.rows.filter((row) => row.kind === 'status' || row.kind === 'empty')).toEqual([]);
    expect(rows.sessionById.size).toBe(86);
    expect(buildSessionBootstrapDemands({ ...input, currentDirectory: null, currentSessionDirectory: null })).toEqual([]);
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
