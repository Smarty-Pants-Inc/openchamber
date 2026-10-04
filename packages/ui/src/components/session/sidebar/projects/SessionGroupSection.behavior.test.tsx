import { describe, expect, mock, spyOn, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { SessionRevealEffect } from '../list/sessionReveal';
import { buildSessionSidebarRowModel } from '../sessionSidebarRowModel';
import { useSidebarGroupStatus } from '../list/useSidebarGroupStatus';
import type { SessionNode } from '../types';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChildStoreManager } from '@/sync/child-store';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroupSectionProps } from './SessionGroupSection';
import { installHookTestDom } from '../test-utils/testDom';

type FolderCallbacks = {
  onRename: (name: string) => void;
  onDelete: () => void;
};

type RowPropsCapture = Pick<SessionGroupSectionProps,
  | 'allowReselect'
  | 'onSessionSelected'
  | 'resetSessionSearch'
  | 'deleteSessionConfirm'
  | 'copiedSessionId'
  | 'setCopiedSessionId'
>;

let folderCallbacks: FolderCallbacks | null = null;
let rowPropsCapture: RowPropsCapture | null = null;
const childStores = new ChildStoreManager();

mock.module('../../SessionFolderItem', () => ({
  SessionFolderItem: (props: FolderCallbacks) => {
    folderCallbacks = props;
    return null;
  },
}));

mock.module('../folders/sessionFolderDnd', () => ({
  DroppableFolderWrapper: ({ children }: { children: (ref: () => void, isOver: boolean) => React.ReactNode }) => <>{children(() => undefined, false)}</>,
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/sync/sync-context', () => ({
  setActiveSession: () => undefined,
  useChildStoreManager: () => childStores,
  useDirectoryStore: () => null,
  useGlobalSessionStatus: () => null,
  useSessionPermissions: () => null,
  useSessionQuestionCount: () => 0,
  useSyncSDK: () => null,
  useSyncDirectory: () => null,
  buildSessionMessageRecordsSnapshot: () => [],
}));

mock.module('../sessions/collapsedActivityIndicator', () => ({
  CollapsedSessionActivityIndicator: () => null,
}));

mock.module('../sessions/collapsedActivityState', () => ({
  useCollapsedSessionActivityState: () => null,
}));

mock.module('../sessions/SessionTreeItem', () => ({
  SessionTreeItem: (props: RowPropsCapture) => {
    rowPropsCapture = props;
    return null;
  },
}));

const { SessionGroupSection, SessionGroupRevealPagination } = await import('./SessionGroupSection');
const { SessionProjectScroller } = await import('./SessionProjectScroller');

const folder: SessionFolder = {
  id: 'folder-a',
  name: 'Initial folder',
  parentId: null,
  sessionIds: [],
  createdAt: 1,
};

const group: SessionGroupSectionProps['group'] = {
  id: 'main',
  label: 'Main',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: '/workspace',
  folderScopeKey: '/workspace',
  sessions: [],
};

const groupWithSession: SessionGroupSectionProps['group'] = {
  ...group,
  // SAFETY: SessionGroupSection only reads the fixture session's id in this test.
  sessions: [{ session: { id: 'session-a' } as Session, children: [], worktree: null }],
};

const createProps = (): SessionGroupSectionProps => ({
  group,
  groupKey: 'project:main',
  projectId: 'project',
  hideGroupLabel: true,
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  groupSearchDataByGroup: new WeakMap(),
  collapsedGroups: new Set(),
  hideDirectoryControls: false,
  showMoreGroupSessions: () => undefined,
  resetGroupSessionLimit: () => undefined,
  mobileVariant: false,
  alwaysShowActions: false,
  activeProjectId: null,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
  notifyOnSubtasks: false,
  expandedParents: new Set(),
  editingId: null,
  editingRowKey: null,
  editTitle: '',
  copiedSessionId: null,
  openSidebarMenuKey: null,
  setEditingId: () => undefined,
  setEditingRowKey: () => undefined,
  setEditTitle: () => undefined,
  toggleParent: () => undefined,
  setOpenSidebarMenuKey: () => undefined,
  startFolderRename: () => undefined,
  allowReselect: false,
  resetSessionSearch: () => undefined,
  deleteSessionConfirm: null,
  setDeleteSessionConfirm: () => undefined,
  setCopiedSessionId: () => undefined,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  onToggleCollapsedGroup: () => undefined,
  folderRename: null,
  setFolderRenameDraft: () => undefined,
  clearFolderRename: () => undefined,
});

describe('SessionGroupSection public behavior', () => {
  test('shared virtual rows keep managed known-empty wording and the checkout head without a duplicate group header', async () => {
    const { Window } = await import('happy-dom');
    const window = new Window({ url: 'http://localhost' });
    // Happy DOM has no layout engine. Give the real virtualizer a nonzero viewport.
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
    const originalSessions = useGlobalSessionsStore.getState();
    const head = { ...group, id: 'head', label: 'CasePreservedHead', workspaceId: 'pi', isWorkspaceHead: true };
    const child = { ...group, id: 'child', label: 'OtherWorkspace', workspaceId: 'code', isWorkspaceHead: false };
    const sections = [{ project: { id: 'project', normalizedPath: '/workspace', label: 'Repository' }, groups: [head, child] }];
    childStores.configure({ onBootstrap: () => undefined });
    childStores.setBootstrapGate(() => 'wait');
    childStores.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'selected-session' });
    const Harness = () => {
      const props = { ...createProps(), hideGroupLabel: false };
      const { groupStatusByKey } = useSidebarGroupStatus({ childStores, sections, chatGroup: null, canGrantAccess: false });
      const rowModel = buildSessionSidebarRowModel({
        mode: 'normal', sections, authoritativeSections: sections, chatGroup: null, recentSections: [], showRecentSection: false,
        foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '', collapsedProjects: new Set(), collapsedGroups: new Set(),
        collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(), visibleCountByContainer: new Map(),
        pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey, folderAuthorityByOwner: new Map(), activeProjectId: 'project',
        singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
      });
      return <ThemeSystemProvider><I18nProvider><TooltipProvider><SessionProjectScroller model={{
        rowModel, sectionsForRender: sections, projectSections: sections, singleProjectMode: false, emptyState: null, searchEmptyState: null,
        projectRepoStatus: new Map(), groupProps: props, state: { editingId: null, openSidebarMenuKey: null, setOpenSidebarMenuKey: () => undefined,
          visibleSessionCountByGroup: new Map(), collapsedActivityKeys: new Set(), setCollapsedActivityKeys: () => undefined,
          visibleActivityCountByKey: new Map(), setVisibleActivityCountByKey: () => undefined },
      }} view={{ homeDirectory: null, hasSessionSearchQuery: false, hideDirectoryControls: false, showOnlyMainWorkspace: false,
        stickyZoneHeaders: false, mobileVariant: false, alwaysShowActions: false, projectSortOrder: 'manual' }}
        actions={{ group: props, toggleProject: () => undefined, setActiveProjectIdOnly: () => undefined, setSessionSwitcherOpen: () => undefined,
          openNewSessionDraft: () => undefined, openNewWorktreeDialog: () => undefined, openWorktreesPage: () => undefined, openProjectEditDialog: () => undefined,
          removeProject: () => undefined, reorderProjects: () => undefined, setGroupOrderByProject: () => undefined, setSingleProjectId: () => undefined }} />
      </TooltipProvider></I18nProvider></ThemeSystemProvider>;
    };
    try {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready' });
      useGlobalSessionsStore.setState({ hasLoaded: true });
      await act(async () => root.render(<Harness />));
      const managed = container.innerHTML;
      expect(managed).toContain('No agent sessions');
      expect(managed).not.toContain('Loading sessions');
      expect(managed).toContain('CasePreservedHead');
      expect(managed).not.toContain('casepreservedhead');
      expect(managed).not.toContain('Collapse CasePreservedHead');
      expect(managed).toContain('OtherWorkspace');
      expect(managed).toContain('data-herdr-children');
      await act(async () => useGlobalSessionsStore.setState({ hasLoaded: false }));
      const unresolved = container.innerHTML;
      expect(unresolved).toContain('Loading sessions');
      expect(unresolved).not.toContain('No agent sessions');
      await act(async () => {
        childStores.disposeAll();
        useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
      });
      const stock = container.innerHTML;
      expect(stock).toContain('No sessions in this workspace yet.');
      expect(stock).not.toContain('No agent sessions');
      expect(stock).not.toContain('data-herdr-children');
    } finally {
      await act(async () => root.unmount());
      childStores.disposeAll();
      childStores.setBootstrapGate(null);
      useProjectsStore.setState(originalProjects, true);
      useGlobalSessionsStore.setState(originalSessions, true);
      fetch.mockRestore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
      await window.happyDOM.close();
    }
  });
  for (const headed of [false, true]) {
    test(`explicit open reveals row 21 through the shared row model ${headed ? 'with a header-only counterexample' : 'without any root header'}`, async () => {
      const { Window } = await import('happy-dom');
      const window = new Window({ url: 'http://localhost' });
      const values = { window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
        HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true };
      const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
      for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
      const root = createRoot(document.createElement('div'));
      const originalProjects = useProjectsStore.getState();
      const originalUi = useSessionUIStore.getState();
      const originalHuman = useHumanAuth.getState();
      const fetch = spyOn(globalThis, 'fetch');
      const writes: string[] = [];
      const nodes: SessionNode[] = Array.from({ length: 21 }, (_, index) => ({
        session: { id: `root-${index + 1}`, directory: '/workspace', title: `Root ${index + 1}`, projectID: 'project', version: '1', slug: `root-${index}`, time: { created: 1, updated: 1 } },
        children: [], worktree: null,
      }));
      const testGroup = { ...group, isMain: !headed, sessions: nodes };
      const groupKey = 'project:main';
      const sections = [{ project: { id: 'project', normalizedPath: '/workspace' }, groups: [testGroup] }];
      const sessionOrderIndex = new Map(nodes.map((node, index) => [node.session.id, index]));
      const pinnedSessionIds = new Set<string>();
      const foldersMap = {};
      let visible = 20;
      let visibleSessionIds: string[] = [];
      let headerCount = 0;
      const Harness = () => {
        const [visibleCount, setVisibleCount] = React.useState(20);
        const showMore = (key: string, count: number, increment = 7) => {
          expect(key).toBe(groupKey);
          visible = count + increment;
          setVisibleCount(visible);
        };
        const rows = buildSessionSidebarRowModel({
          mode: 'normal', sections, authoritativeSections: sections, chatGroup: null, recentSections: [], showRecentSection: false,
          foldersMap, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '', collapsedProjects: new Set(), collapsedGroups: new Set(),
          collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(), visibleCountByContainer: new Map([[groupKey, visibleCount]]),
          pinnedSessionIds, sessionOrderIndex, groupStatusByKey: new Map(), folderAuthorityByOwner: new Map(), activeProjectId: 'project',
          singleProjectMode: true, singleProjectId: 'project', showOnlyMainWorkspace: false, hideDirectoryControls: false, sessionBatchSize: 20,
        });
        visibleSessionIds = rows.rows.flatMap((row) => row.kind === 'session' ? [row.node.session.id] : []);
        headerCount = rows.rows.filter((row) => row.kind === 'group-header').length;
        return <I18nProvider>
          <SessionRevealEffect sections={sections} />
          <SessionGroupRevealPagination group={testGroup} groupKey={groupKey} foldersMap={foldersMap} sessionOrderIndex={sessionOrderIndex}
            pinnedSessionIds={pinnedSessionIds} visibleCount={visibleCount} showMore={showMore} />
          {headed ? <SessionGroupSection {...createProps()} group={testGroup} hideGroupLabel={false} renderBody={false} visibleSessionCount={visibleCount}
            sessionOrderIndex={sessionOrderIndex} showMoreGroupSessions={showMore} /> : null}
        </I18nProvider>;
      };
      try {
        configureRuntimeUrlResolver({ apiBaseUrl: 'https://sidebar-reveal.test' });
        useAuthSessionStore.getState().markAuthenticated();
        useHumanAuth.setState({ enabled: true });
        useProjectsStore.setState({ projects: [{ id: 'project', path: '/workspace' }], managedCatalogAdmitted: false, managedSessionHold: null });
        useSessionUIStore.getState().setCurrentSession(null);
        fetch.mockImplementation(async (_input, init) => {
          if (init?.method === 'PATCH') { writes.push(String(init.body)); return Response.json({}); }
          return Response.json({ owner: { issuer: 'test', subject: headed ? 'headed' : 'headerless' }, projects: {}, groups: {} });
        });
        await act(async () => root.render(<Harness />));
        expect(visibleSessionIds).toHaveLength(20);
        expect(visibleSessionIds).not.toContain('root-21');
        expect(headerCount).toBe(headed ? 1 : 0);
        await act(async () => useSessionUIStore.getState().setCurrentSession('root-21', '/workspace'));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(visible).toBe(21);
        expect(visibleSessionIds).toHaveLength(21);
        expect(visibleSessionIds).toContain('root-21');
        expect(writes).toHaveLength(1);
        expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
      } finally {
        await act(async () => root.unmount());
        fetch.mockRestore();
        useHumanAuth.setState(originalHuman, true);
        configureRuntimeUrlResolver({});
        useProjectsStore.setState(originalProjects, true);
        useSessionUIStore.setState(originalUi, true);
        for (const [name, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
        }
        await window.happyDOM.close();
      }
    });
  }
  test('an empty successful list does not spin for initialization and keeps initialization failure retryable', async () => {
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<void>((_resolve, reject) => { rejectInitialization = reject; });
    childStores.configure({ onBootstrap: (context) => { context.trackInitialization(initialization); } });
    childStores.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'selected-session' });
    await Promise.resolve();
    await Promise.resolve();
    try {
      const waiting = renderToStaticMarkup(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>);
      expect(waiting).toContain('No sessions in this workspace yet.');
      expect(waiting).not.toContain('Loading sessions');
      rejectInitialization(new Error('initialization failed'));
      await Promise.resolve();
      await Promise.resolve();
      const failed = renderToStaticMarkup(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>);
      expect(failed).toContain('Could not initialize workspace.');
      expect(failed).toContain('Try again');
      expect(failed).not.toContain('Could not refresh sessions.');
    } finally {
      rejectInitialization(new Error('test finished'));
      childStores.disposeAll();
    }
  });

  test('routes rendered folder rename and delete actions to the owning folder store', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalUi = useUIStore.getState();
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [folder] } });
    useUIStore.setState({ showDeletionDialog: false });

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>));
      expect(folderCallbacks).not.toBeNull();

      await act(async () => folderCallbacks?.onRename('Renamed folder'));
      expect(useSessionFoldersStore.getState().foldersMap['/workspace']?.[0]?.name).toBe('Renamed folder');

      await act(async () => folderCallbacks?.onDelete());
      expect(useSessionFoldersStore.getState().foldersMap['/workspace']).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useUIStore.setState(originalUi, true);
      folderCallbacks = null;
      dom.restore();
    }
  });

  test('propagates confirmation, search/navigation, and copy ownership changes to rendered rows', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const firstSelected = () => undefined;
    const nextSelected = () => undefined;
    const firstResetSearch = () => undefined;
    const nextResetSearch = () => undefined;
    const firstCopied = () => undefined;
    const nextCopied = () => undefined;
    const initialProps = createProps();

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} onSessionSelected={firstSelected} resetSessionSearch={firstResetSearch} setCopiedSessionId={firstCopied} /></I18nProvider>));
      expect(rowPropsCapture?.onSessionSelected).toBe(firstSelected);
      expect(rowPropsCapture?.resetSessionSearch).toBe(firstResetSearch);
      expect(rowPropsCapture?.deleteSessionConfirm).toBeNull();
      expect(rowPropsCapture?.copiedSessionId).toBeNull();
      expect(rowPropsCapture?.setCopiedSessionId).toBe(firstCopied);

      // SAFETY: the confirmation is only forwarded by identity to the row mock.
      const confirmation = { session: { id: 'session-a' } as Session, descendantCount: 0, descendantIds: [], archivedBucket: false };
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} allowReselect onSessionSelected={nextSelected} resetSessionSearch={nextResetSearch} deleteSessionConfirm={confirmation} copiedSessionId="session-a" setCopiedSessionId={nextCopied} /></I18nProvider>));
      expect(rowPropsCapture?.allowReselect).toBe(true);
      expect(rowPropsCapture?.onSessionSelected).toBe(nextSelected);
      expect(rowPropsCapture?.resetSessionSearch).toBe(nextResetSearch);
      expect(rowPropsCapture?.deleteSessionConfirm).toBe(confirmation);
      expect(rowPropsCapture?.copiedSessionId).toBe('session-a');
      expect(rowPropsCapture?.setCopiedSessionId).toBe(nextCopied);
    } finally {
      await act(async () => root.unmount());
      rowPropsCapture = null;
      dom.restore();
    }
  });

  test('an empty workspace says "No agent sessions" in Smarty Code, and keeps its stock wording otherwise (smarty-code#126)', async () => {
    const { Window } = await import('happy-dom');
    const window = new Window({ url: 'http://localhost' });
    const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
    const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = { window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
      HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
    for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    // SAFETY: happy-dom's element implements the DOM Element interface React renders into; only its types differ.
    const root = createRoot(container as unknown as Element);
    const original = useProjectsStore.getState(), originalSessions = useGlobalSessionsStore.getState();
    try {
      for (const [admitted, expected] of [[true, 'No agent sessions'], [false, 'No sessions in this workspace yet.']] as const) {
        useProjectsStore.setState({ managedCatalogAdmitted: admitted });
        await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>));
        expect(container.textContent).toContain(expected);
      }
      // #126 (c)6: the managed catalog's session read already lists every workspace, so an empty one is known empty
      // while its scope bootstrap still waits in the queue; it never shows "Loading sessions…" (fresh profile, 20 s).
      childStores.configure({ onBootstrap: () => undefined });
      childStores.setBootstrapGate(() => 'wait');
      childStores.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'selected-session' });
      expect(childStores.getBootstrapState('/workspace')).toBe('queued');
      for (const [admitted, catalog, loaded, expected] of [
        [true, 'ready', true, 'No agent sessions'],
        [true, 'ready', false, 'Loading sessions'], // Its session read has not answered yet.
        [false, 'stock', true, 'Loading sessions'], // Stock keeps its scope bootstrap as the authority.
      ] as const) {
        useProjectsStore.setState({ managedCatalogAdmitted: admitted, managedCatalogStatus: catalog });
        useGlobalSessionsStore.setState({ hasLoaded: loaded });
        await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>));
        expect(container.textContent).toContain(expected);
      }
      // F7: Herdr shows no branch under a workspace name; stock keeps its branch line.
      childStores.disposeAll();
      const branched = { ...group, id: 'ci', label: 'ci-delivery', isMain: false, branch: 'ci/role-definition-successor-20260919' };
      for (const [admitted, shown] of [[true, false], [false, true]] as const) {
        useProjectsStore.setState({ managedCatalogAdmitted: admitted, managedCatalogStatus: admitted ? 'ready' : 'stock' });
        await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} group={branched} hideGroupLabel={false} /></I18nProvider>));
        expect(container.textContent?.includes('ci/role-definition-successor-20260919')).toBe(shown);
      }
    } finally {
      childStores.disposeAll();
      childStores.setBootstrapGate(null);
      await act(async () => root.unmount());
      useProjectsStore.setState(original, true);
      useGlobalSessionsStore.setState(originalSessions, true);
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
