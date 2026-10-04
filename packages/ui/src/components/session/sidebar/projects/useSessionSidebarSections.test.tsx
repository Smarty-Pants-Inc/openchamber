import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSidebarSections } from './useSessionSidebarSections';
import type { SessionGroup } from '../types';
import type { WorktreeMetadata } from '@/types/worktree';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { installHookTestDom } from '../test-utils/testDom';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';

const CHATS_ROOT = '/home/user/.config/openchamber/chats';

const chatSession = (id: string, title: string): Session => ({
  id,
  slug: id,
  projectID: 'chats',
  title,
  version: '1',
  directory: `${CHATS_ROOT}/2026-08-28/session-${id}`,
  time: { created: 1, updated: 1 },
});

const chatsGroup = (sessions: Session[]): SessionGroup => ({
  id: 'managed-chats',
  label: '',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: CHATS_ROOT,
  folderScopeKey: CHATS_ROOT,
  folderScopes: [{ scopeKey: CHATS_ROOT, directory: CHATS_ROOT }],
  draftTarget: 'chat',
  sessions: sessions.map((session) => ({ session, children: [], worktree: null })),
});

type Sections = ReturnType<typeof useSessionSidebarSections>;

// The real matcher and the real grouping callbacks run here: the reported bug
// was never about matching, so a stubbed matcher would test nothing.
const renderSections = (
  group: SessionGroup,
  query: string,
  projectSessions?: Session[],
  foldersMap: SessionFoldersMap = { [CHATS_ROOT]: [{ id: 'folder', name: group.label, sessionIds: [], createdAt: 1 }] },
): Sections => {
  let captured: Sections | null = null;
  const Harness = () => {
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: new Map(),
      pinnedSessionIds: new Set(),
      sessionOrderRanks: new Map(),
      gitBranches: new Map(),
      isVSCode: false,
    });
    captured = useSessionSidebarSections({
      normalizedProjects: projectSessions ? [{ id: 'project', path: CHATS_ROOT, normalizedPath: CHATS_ROOT }] : [],
      getSessionsForProject: () => projectSessions?.filter((session) => !session.time.archived) ?? [],
      getArchivedSessionsForProject: () => projectSessions?.filter((session) => Boolean(session.time.archived)) ?? [],
      availableWorktreesByProject: new Map(),
      projectRepoStatus: new Map(),
      projectRootBranches: new Map(),
      gitBranches: new Map(),
      lastRepoStatus: false,
      buildGroupedSessions: grouping.buildGroupedSessions,
      hasSessionSearchQuery: query.length > 0,
      normalizedSessionSearchQuery: query,
      filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
      buildGroupSearchText: grouping.buildGroupSearchText,
      foldersMap,
      standaloneGroups: projectSessions ? [] : [group],
    });
    return null;
  };

  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook was not mounted');
  return captured;
};

// Issue #3200: the managed chats render outside every project section. They
// were left out of the search pass, and a group without search data renders
// `filteredNodes ?? []` — so every chat disappeared as soon as a query was
// typed, however well its title matched.
describe('sidebar search over standalone groups', () => {
  const targetId = 'ses_f88b1a2b3c4d';

  test('finds project sessions in flat results without searching their archived bucket', () => {
    const active = { ...chatSession(targetId, 'Active'), directory: CHATS_ROOT };
    const archived = { ...chatSession('ses_archived', 'Archived'), directory: CHATS_ROOT, time: { created: 1, updated: 1, archived: 2 } };
    const group = chatsGroup([]);
    const sections = renderSections(group, targetId, [active, archived]);
    expect(sections.flatSectionsForRender[0].groups[0].sessions.map((node) => node.session.id)).toEqual([targetId]);
    expect(sections.searchMatchCount).toBe(1);
    const archivedSearch = renderSections(group, archived.id, [active, archived]);
    expect(archivedSearch.flatSectionsForRender).toEqual([]);
    expect(archivedSearch.searchMatchCount).toBe(0);
  });

  test('matches only a complete ID, ignoring case and surrounding whitespace', () => {
    const group = chatsGroup([
      chatSession(targetId, 'Release notes'),
      chatSession('ses_f88b1a2b3c4e', targetId),
    ]);
    group.label = targetId;
    for (const query of [targetId, `  ${targetId.toUpperCase()}\n`]) {
      const sections = renderSections(group, query);
      const data = sections.groupSearchDataByGroup.get(group);
      expect(data?.filteredNodes.map((node) => node.session.id)).toEqual([targetId]);
      expect(data?.groupMatches).toBe(false);
      expect(data?.folderNameMatchCount).toBe(0);
      expect(sections.searchMatchCount).toBe(1);
    }
    for (const query of ['ses_', 'ses_f88b', 'ses_f88b1a2b3c4f', `${targetId}x`, `${targetId} error`]) {
      expect(renderSections(group, query).searchMatchCount).toBe(0);
    }
  });

  test('keeps tree context and counts only the ID match', () => {
    const group = chatsGroup([chatSession('ses_parent', 'Parent')]);
    const parent = group.sessions[0];
    parent.children = [
      { session: chatSession(targetId, 'Child'), children: [], worktree: null },
      { session: chatSession('ses_sibling', 'Sibling'), children: [], worktree: null },
    ];
    const sections = renderSections(group, targetId);
    const nodes = sections.groupSearchDataByGroup.get(group)?.filteredNodes;
    expect(nodes?.map((node) => node.session.id)).toEqual(['ses_parent']);
    expect(nodes?.[0].children.map((node) => node.session.id)).toEqual([targetId]);
    expect(sections.searchMatchCount).toBe(1);
    const parentSections = renderSections(group, 'ses_parent');
    expect(parentSections.groupSearchDataByGroup.get(group)?.filteredNodes[0]).toBe(parent);
    expect(parentSections.searchMatchCount).toBe(1);
    expect(parent.children).toHaveLength(2);
  });

  test('does not return archived sessions for an ID query', () => {
    const archived = chatSession(targetId, 'Archived');
    archived.time.archived = 2;
    const group = chatsGroup([archived]);
    expect(renderSections(group, targetId).searchMatchCount).toBe(0);
  });

  test('keeps a matching chat in the group the sidebar renders', () => {
    const group = chatsGroup([
      chatSession('ses_a', 'Release notes for 1.21'),
      chatSession('ses_b', 'Unrelated grocery list'),
    ]);

    const sections = renderSections(group, 'release');
    const data = sections.groupSearchDataByGroup.get(group);

    expect(data).toBeDefined();
    expect(data?.filteredNodes.map((node) => node.session.id)).toEqual(['ses_a']);
    expect(data?.hasMatch).toBe(true);
  });

  test('counts chat matches in the header count', () => {
    const group = chatsGroup([
      chatSession('ses_a', 'Release notes for 1.21'),
      chatSession('ses_b', 'Release checklist'),
      chatSession('ses_c', 'Unrelated grocery list'),
    ]);

    expect(renderSections(group, 'release').searchMatchCount).toBe(2);
  });

  test('searches folders from every managed Chats scope', () => {
    const group = chatsGroup([]);
    const alternateScope = `${CHATS_ROOT}/2026-08-28/session-a`;
    group.folderScopes = [
      { scopeKey: CHATS_ROOT, directory: CHATS_ROOT },
      { scopeKey: alternateScope, directory: alternateScope },
    ];
    const sections = renderSections(group, 'alternate', undefined, {
      [CHATS_ROOT]: [],
      [alternateScope]: [{ id: 'alternate-folder', name: 'Alternate notes', sessionIds: [], createdAt: 1 }],
    });

    expect(sections.groupSearchDataByGroup.get(group)?.folderNameMatchCount).toBe(1);
    expect(sections.searchMatchCount).toBe(1);
  });

  test('reports no match for a chat group nothing matches in', () => {
    const group = chatsGroup([chatSession('ses_a', 'Release notes for 1.21')]);

    const sections = renderSections(group, 'groceries');
    const data = sections.groupSearchDataByGroup.get(group);

    expect(data?.filteredNodes).toEqual([]);
    expect(data?.hasMatch).toBe(false);
    expect(sections.searchMatchCount).toBe(0);
  });

  test('skips the search pass entirely when no query is active', () => {
    const group = chatsGroup([chatSession('ses_a', 'Release notes for 1.21')]);

    const sections = renderSections(group, '');

    expect(sections.groupSearchDataByGroup.has(group)).toBe(false);
    expect(sections.searchMatchCount).toBe(0);
  });
});

// Sidebar audit 2026-09-23 (code.smartypants.ai): the managed catalog lists a repository and its
// linked worktrees as separate projects. Git discovery also listed the worktree under its parent,
// so the parent section folded the worktree in (a duplicate row and a scope bootstrap the gateway
// refuses) while the worktree's own section spun. A worktree that is its own project renders only there.
describe('worktrees that are their own projects', () => {
  for (const managed of [true, false]) test(`${managed ? 'managed catalog: are not folded into the parent' : 'stock: keep their parent worktree group'}`, () => {
    let captured: Sections | null = null;
    const parent = { id: 'herdr', path: '/p/herdr', normalizedPath: '/p/herdr', label: 'herdr' };
    const child = { id: 'upstream', path: '/p/herdr/worktrees/upstream-0.9', normalizedPath: '/p/herdr/worktrees/upstream-0.9', label: 'upstream-0.9' };
    const other = { path: '/p/herdr/worktrees/scratch', name: 'scratch', branch: 'scratch', label: 'scratch' };
    const worktrees = new Map([[parent.normalizedPath, [
      { path: child.normalizedPath, name: 'upstream-0.9', branch: 'upstream-0.9', label: 'upstream-0.9' }, other,
    ]]]);
    const Harness = () => {
      const grouping = useSessionGrouping({ homeDirectory: '/home/user', worktreeMetadata: new Map(), pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(), gitBranches: new Map(), isVSCode: false });
      captured = useSessionSidebarSections({
        // SAFETY: the hook reads only id and normalizedPath from project items in this path.
        normalizedProjects: [parent, child] as unknown as Parameters<typeof useSessionSidebarSections>[0]['normalizedProjects'],
        getSessionsForProject: () => [], getArchivedSessionsForProject: () => [],
        // SAFETY: fixture worktree metadata carries the fields the grouping reads.
        availableWorktreesByProject: worktrees as unknown as Parameters<typeof useSessionSidebarSections>[0]['availableWorktreesByProject'],
        projectRepoStatus: new Map([['herdr', true], ['upstream', true]]), projectRootBranches: new Map(), gitBranches: new Map(),
        lastRepoStatus: true, buildGroupedSessions: grouping.buildGroupedSessions, hasSessionSearchQuery: false,
        normalizedSessionSearchQuery: '', filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
        buildGroupSearchText: grouping.buildGroupSearchText, foldersMap: {}, standaloneGroups: [],
        excludeWorktreeProjects: managed,
      });
      return null;
    };
    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    if (!captured) throw new Error('sections hook was not mounted');
    const sections = (captured as Sections).projectSections;
    const parentDirs = sections.find((section) => section.project.id === 'herdr')!.groups.map((group) => group.directory);
    if (managed) expect(parentDirs).not.toContain(child.normalizedPath);
    else expect(parentDirs).toContain(child.normalizedPath);
    expect(parentDirs).toContain('/p/herdr/worktrees/scratch');
    // The worktree still renders as its own project section.
    expect(sections.find((section) => section.project.id === 'upstream')!.groups.some((group) => group.directory === child.normalizedPath)).toBe(true);
    // The flat view's bootstrap scopes follow the same rule.
    const flatScopes = (captured as Sections).flatSectionsForRender.find((section) => section.project.id === 'herdr')!.groups[0]!.folderScopes!.map((scope) => scope.directory);
    expect(flatScopes.includes(child.normalizedPath)).toBe(!managed);
  });
});

// smarty-code#881: a worktree removed (Herdr workspace closed, `git worktree remove`) leaves the live catalog, but the
// published git topology still lists it under its parent, so the sidebar kept a dead group ("Could not refresh sessions").
describe('managed catalog: a worktree that leaves the catalog', () => {
  const parent = { id: 'herdr', path: '/p/herdr', normalizedPath: '/p/herdr', label: 'herdr' };
  const gone = '/p/herdr/worktrees/gone', kept = '/p/herdr/worktrees/kept', unlisted = '/p/herdr/worktrees/unlisted';
  const worktrees = new Map<string, WorktreeMetadata[]>([[parent.normalizedPath,
    [gone, kept, unlisted].map((path) => ({ path, projectDirectory: parent.path, branch: path, label: path }))]]);
  const catalog = (...paths: string[]) => useProjectsStore.getState().applyManagedCatalog(
    [parent.path, ...paths].map((worktree) => ({ id: worktree, worktree })));

  test('its group is gone once the catalog drops it; a listed worktree stays; one never listed is unaffected; it returns when listed again', async () => {
    const initial = useProjectsStore.getState();
    const dom = installHookTestDom(), root = createRoot(dom.container);
    let captured: Sections | undefined;
    const Harness = () => {
      const grouping = useSessionGrouping({ homeDirectory: '/home/user', worktreeMetadata: new Map(), pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(), gitBranches: new Map(), isVSCode: false });
      captured = useSessionSidebarSections({
        normalizedProjects: [parent],
        getSessionsForProject: () => [], getArchivedSessionsForProject: () => [],
        availableWorktreesByProject: worktrees,
        projectRepoStatus: new Map([['herdr', true]]), projectRootBranches: new Map(), gitBranches: new Map(),
        lastRepoStatus: true, buildGroupedSessions: grouping.buildGroupedSessions, hasSessionSearchQuery: false,
        normalizedSessionSearchQuery: '', filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
        buildGroupSearchText: grouping.buildGroupSearchText, foldersMap: {}, standaloneGroups: [], excludeWorktreeProjects: true,
      });
      return null;
    };
    const groupDirs = () => captured?.projectSections[0]?.groups.map((group) => group.directory) ?? [];
    try {
      // `gone` and `kept` are live catalog worktrees; `unlisted` never was in the catalog (not departed).
      catalog(gone, kept);
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      for (const path of [gone, kept, unlisted]) expect(groupDirs()).toContain(path);
      await act(async () => catalog(kept));
      expect(groupDirs()).not.toContain(gone);
      for (const path of [kept, unlisted]) expect(groupDirs()).toContain(path);
      await act(async () => catalog(gone, kept));
      expect(groupDirs()).toContain(gone);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      useProjectsStore.setState(initial, true);
    }
  });
});
