import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SyncProvider, useSyncRuntime } from '@/sync/sync-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useHumanAuth } from '@/lib/human-auth';
import { buildSessionSidebarRowModel, type SessionSidebarRowModelArgs } from '../sessionSidebarRowModel';
// Bun has no Vite asset glob transform. Expand only the asset map, keeping the real hook and rows.
plugin({ name: 'sidebar-provider-logo-assets', setup(build) {
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
    const folder = resolve(dirname(path), '../assets/provider-logos');
    const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
      .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
    return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { SessionProjectScroller } = await import('./SessionProjectScroller');
import { buildGroupRenderDescriptors, resolveSearchResultPlacement, selectRenderedProjectSections } from './sessionProjectRender';
import type { SessionGroup } from '../types';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

const makeGroup = (id: string, overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'main',
  worktree: null,
  directory: '/workspace',
  sessions: [],
  ...overrides,
});

describe('buildGroupRenderDescriptors', () => {
  test('renders the main group and archived bucket for the main workspace', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('archived', { isArchivedBucket: true })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: true })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:archived',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('renders the primary group without a label and nested groups with labels', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('feature')],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:feature',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('keeps labels when a flat section has no main group', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('feature', { isMain: false }), makeGroup('other', { isMain: false })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false }).map((descriptor) => descriptor.hideGroupLabel)).toEqual([false, false]);
  });
});

test('actual scroller keeps a collapsed checkout head reachable only while headerless without resetting its preference', async () => {
  const window = new Window({ url: 'http://localhost' });
  // Happy DOM supplies identity and events, not layout. Keep the real virtualizer active.
  for (const [name, value] of [['offsetHeight', 600], ['clientHeight', 600], ['offsetWidth', 300], ['clientWidth', 300]] as const) {
    Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  const values = { window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement, ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver, CustomEvent: window.CustomEvent, Event: window.Event,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
  const originalProjects = useProjectsStore.getState();
  const originalConfig = useConfigStore.getState();
  const originalFolders = useSessionFoldersStore.getState();
  const originalHuman = useHumanAuth.getState();
  const headKey = 'project-a:head';
  const childKey = 'project-a:child';
  const collapsedGroups = new Set([headKey, childKey]);
  const head = makeGroup('head', { label: 'CasePreservedHead', isMain: true, workspaceId: 'pi', isWorkspaceHead: true,
    folderScopeKey: '/workspace', sessions: [{ session: { id: 'head-session', title: 'Head session', slug: 'head-session', version: '1', projectID: 'project-a', directory: '/workspace', time: { created: 1, updated: 1 } }, children: [], worktree: null }] });
  const child = makeGroup('child', { label: 'ChildWorkspace', isMain: true, workspaceId: 'code', folderScopeKey: '/workspace#workspace:code',
    sessions: [{ session: { id: 'child-session', title: 'Child session', slug: 'child-session', version: '1', projectID: 'project-a', directory: '/workspace', time: { created: 1, updated: 1 } }, children: [], worktree: null }] });
  const sections = [{ project: { id: 'project-a', normalizedPath: '/workspace', label: 'Repository' }, groups: [head, child] }];
  const sdkRequests: string[] = [];
  const sdk = createOpencodeClient({ baseUrl: 'https://scroller.test', fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    sdkRequests.push(`${url.pathname}${url.search}`);
    return url.pathname.endsWith('/global/event')
      ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json([]);
  } });
  let runtime: ReturnType<typeof useSyncRuntime> | undefined;
  let projectToggles = 0;
  let groupToggles = 0;
  let currentCollapsedGroups = collapsedGroups;
  const Probe = () => { runtime = useSyncRuntime(); return null; };
  const Harness = ({ headed }: { headed: boolean }) => {
    const [collapsedProjects, setCollapsedProjects] = React.useState(new Set<string>());
    const [groupCollapse, setGroupCollapse] = React.useState(collapsedGroups);
    currentCollapsedGroups = groupCollapse;
    const groupProps: React.ComponentProps<typeof SessionProjectScroller>['model']['groupProps'] = {
      hasSessionSearchQuery: false, normalizedSessionSearchQuery: '', groupSearchDataByGroup: new WeakMap(), collapsedGroups: groupCollapse,
      hideDirectoryControls: false, mobileVariant: false, alwaysShowActions: false, activeProjectId: 'project-a', notifyOnSubtasks: false,
      pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), expandedParents: new Set(), editingRowKey: null, editTitle: '', copiedSessionId: null,
      folderRename: null, setFolderRenameDraft: () => undefined, clearFolderRename: () => undefined, setEditingId: () => undefined,
      setEditingRowKey: () => undefined, setEditTitle: () => undefined, toggleParent: () => undefined, allowReselect: false,
      resetSessionSearch: () => undefined, deleteSessionConfirm: null, setDeleteSessionConfirm: () => undefined, startFolderRename: () => undefined,
      setCopiedSessionId: () => undefined, startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
    };
    const input: SessionSidebarRowModelArgs = {
      mode: 'normal', sections, authoritativeSections: sections, chatGroup: null, recentSections: [], showRecentSection: false,
      foldersMap: useSessionFoldersStore.getState().foldersMap, groupSearchDataByGroup: groupProps.groupSearchDataByGroup, normalizedQuery: '',
      collapsedProjects, collapsedGroups: groupCollapse, collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(),
      visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey: new Map(),
      folderAuthorityByOwner: new Map([['project-a', { scopeKeys: ['/workspace'], complete: true }]]), activeProjectId: 'project-a',
      singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: headed, hideDirectoryControls: false,
    };
    return React.createElement(SessionProjectScroller, {
      model: { rowModel: buildSessionSidebarRowModel(input), sectionsForRender: sections, projectSections: sections, singleProjectMode: false,
        emptyState: null, searchEmptyState: null, projectRepoStatus: new Map(), groupProps,
        state: { editingId: null, openSidebarMenuKey: null, setOpenSidebarMenuKey: () => undefined, visibleSessionCountByGroup: new Map(),
          collapsedActivityKeys: new Set<string>(), setCollapsedActivityKeys: () => undefined, visibleActivityCountByKey: new Map(), setVisibleActivityCountByKey: () => undefined } },
      view: { homeDirectory: null, hasSessionSearchQuery: false, hideDirectoryControls: false, showOnlyMainWorkspace: headed,
        stickyZoneHeaders: false, mobileVariant: false, alwaysShowActions: false, projectSortOrder: 'manual' },
      actions: {
        group: { showMoreGroupSessions: () => undefined, resetGroupSessionLimit: () => undefined, setActiveProjectIdOnly: () => undefined,
          setSessionSwitcherOpen: () => undefined, openNewSessionDraft: () => undefined, onToggleCollapsedGroup: (key) => {
            groupToggles += 1;
            setGroupCollapse((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            });
          } },
        toggleProject: (id) => { projectToggles += 1; setCollapsedProjects((current) => current.has(id) ? new Set() : new Set([id])); },
        setActiveProjectIdOnly: () => undefined, setSessionSwitcherOpen: () => undefined, openNewSessionDraft: () => undefined,
        openNewWorktreeDialog: () => undefined, openWorktreesPage: () => undefined, openProjectEditDialog: () => undefined,
        removeProject: () => undefined, reorderProjects: () => undefined, setGroupOrderByProject: () => undefined, setSingleProjectId: () => undefined,
      },
    });
  };
  const render = (headed: boolean) => act(async () => root.render(
    React.createElement(SyncProvider, { sdk, directory: '', children:
      React.createElement(ThemeSystemProvider, { children: React.createElement(I18nProvider, { children:
        React.createElement(TooltipProvider, { children: [React.createElement(Probe, { key: 'probe' }), React.createElement(Harness, { key: 'scroller', headed })] }) }) }) }),
  ));
  try {
    useHumanAuth.setState({ enabled: false });
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready' });
    useConfigStore.setState({ settingsMessageStreamTransport: 'sse' });
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [{ id: 'head-folder', name: 'Head folder', createdAt: 1, sessionIds: ['head-session'] }] } });
    for (const headed of [true, false, true]) {
      await render(headed);
      expect(container.querySelector('[data-sidebar-virtual-ready]')).not.toBeNull();
      expect(container.querySelector('[data-session-row="head-session"]') !== null).toBe(!headed);
      expect(container.textContent?.includes('Head folder')).toBe(!headed);
      expect(container.querySelector('[aria-label="Expand CasePreservedHead"]') !== null).toBe(headed);
      expect(container.querySelector('[aria-label="Expand ChildWorkspace"]')).not.toBeNull();
      expect(container.querySelector('[data-session-row="child-session"]')).toBeNull();
      expect(container.textContent).toContain('CasePreservedHead');
      expect(container.textContent).not.toContain('casepreservedhead');
      const headRow = container.querySelector('[data-session-row="head-session"]');
      if (headRow) expect(headRow.closest('[data-herdr-children]')).toBeNull();
      const childHeader = container.querySelector('[aria-label="Expand ChildWorkspace"]');
      expect(childHeader?.closest('[data-herdr-children]') !== null).toBe(!headed);
      expect([...collapsedGroups]).toEqual([headKey, childKey]);
    }
    await render(false);
    const collapseProject = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('CasePreservedHead'));
    if (!collapseProject) throw new Error('Missing project collapse control');
    await act(async () => collapseProject.click());
    expect(container.querySelector('[data-session-row="head-session"]')).toBeNull();
    const expandProject = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('CasePreservedHead'));
    if (!expandProject) throw new Error('Missing project expansion control');
    await act(async () => expandProject.click());
    expect(container.querySelector('[data-session-row="head-session"]')).not.toBeNull();
    await render(true);
    expect(container.querySelector('[data-session-row="head-session"]')).toBeNull();
    expect(container.querySelector('[aria-label="Expand CasePreservedHead"]')).not.toBeNull();
    expect(projectToggles).toBe(2);
    expect(groupToggles).toBe(0);
    expect([...collapsedGroups]).toEqual([headKey, childKey]);
    expect(currentCollapsedGroups).toBe(collapsedGroups);
    const expandHead = container.querySelector<HTMLElement>('[aria-label="Expand CasePreservedHead"]');
    if (!expandHead) throw new Error('Missing headed-view expansion control');
    await act(async () => expandHead.click());
    expect(container.querySelector('[data-session-row="head-session"]')).not.toBeNull();
    expect(currentCollapsedGroups.has(headKey)).toBe(false);
    expect(currentCollapsedGroups.has(childKey)).toBe(true);
    const collapseHead = container.querySelector<HTMLElement>('[aria-label="Collapse CasePreservedHead"]');
    if (!collapseHead) throw new Error('Missing headed-view collapse control');
    await act(async () => collapseHead.click());
    expect(container.querySelector('[data-session-row="head-session"]')).toBeNull();
    expect(groupToggles).toBe(2);
    expect([...currentCollapsedGroups].sort()).toEqual([headKey, childKey].sort());
    // Row subscriptions may acquire the directory store, but never bootstrap it.
    expect(runtime?.childStores.getBootstrapState('/workspace')).toBeUndefined();
    expect(sdkRequests.filter((request) => request.includes('directory=') || request.includes('/session'))).toEqual([]);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState(originalProjects, true);
    useConfigStore.setState(originalConfig, true);
    useSessionFoldersStore.setState(originalFolders, true);
    useHumanAuth.setState(originalHuman, true);
    fetch.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});

describe('single-project scroller projection', () => {
  test('renders only the selected project from persisted display state', () => {
    const previous = useSessionDisplayStore.getState();
    const sections = [
      { project: { id: 'project-a', normalizedPath: '/workspace/a' }, groups: [] },
      { project: { id: 'project-b', normalizedPath: '/workspace/b' }, groups: [] },
    ];

    try {
      useSessionDisplayStore.setState({ projectDisplayMode: 'single', singleProjectId: 'project-b' });
      const state = useSessionDisplayStore.getState();

      expect(selectRenderedProjectSections(sections, state.projectDisplayMode === 'single', state.singleProjectId)
        .map((section) => section.project.id)).toEqual(['project-b']);
    } finally {
      useSessionDisplayStore.setState(previous, true);
    }
  });
});

// Issue #3200: a query matching only a managed chat leaves no project section to
// render. The chats live in the scroller's top content, so answering with the
// empty state there hid a result the header was already counting.
describe('resolveSearchResultPlacement', () => {
  test('keeps the top content when the only match lives there', () => {
    expect(resolveSearchResultPlacement(true)).toBe('top-content');
  });

  test('falls back to the empty state when nothing matched anywhere', () => {
    expect(resolveSearchResultPlacement(false)).toBe('empty-state');
  });
});
