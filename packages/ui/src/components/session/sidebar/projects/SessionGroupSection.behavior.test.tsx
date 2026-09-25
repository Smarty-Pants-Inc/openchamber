import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
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
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'deleteSessionConfirm'
  | 'copiedSessionId'
  | 'setCopiedSessionId'
>;

let folderCallbacks: FolderCallbacks | null = null;
let rowPropsCapture: RowPropsCapture | null = null;

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

let bootstrapState: string | null = null;
mock.module('@/sync/sync-context', () => ({
  setActiveSession: () => undefined,
  useChildStoreManager: () => ({
    subscribeBootstrap: () => () => undefined,
    getBootstrapState: () => bootstrapState,
    getBootstrapFailure: () => undefined,
    requestBootstrap: () => undefined,
  }),
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

const { SessionGroupSection } = await import('./SessionGroupSection');

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
  editTitle: '',
  copiedSessionId: null,
  openSidebarMenuKey: null,
  setEditingId: () => undefined,
  setEditTitle: () => undefined,
  toggleParent: () => undefined,
  setOpenSidebarMenuKey: () => undefined,
  startFolderRename: () => undefined,
  allowReselect: false,
  isSessionSearchOpen: false,
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  setIsSessionSearchOpen: () => undefined,
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
    const firstCopied = () => undefined;
    const nextCopied = () => undefined;
    const initialProps = createProps();

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} onSessionSelected={firstSelected} setCopiedSessionId={firstCopied} /></I18nProvider>));
      expect(rowPropsCapture?.onSessionSelected).toBe(firstSelected);
      expect(rowPropsCapture?.sessionSearchQuery).toBe('');
      expect(rowPropsCapture?.deleteSessionConfirm).toBeNull();
      expect(rowPropsCapture?.copiedSessionId).toBeNull();
      expect(rowPropsCapture?.setCopiedSessionId).toBe(firstCopied);

      // SAFETY: the confirmation is only forwarded by identity to the row mock.
      const confirmation = { session: { id: 'session-a' } as Session, descendantCount: 0, descendantIds: [], archivedBucket: false };
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} allowReselect onSessionSelected={nextSelected} isSessionSearchOpen sessionSearchQuery="search" deleteSessionConfirm={confirmation} copiedSessionId="session-a" setCopiedSessionId={nextCopied} /></I18nProvider>));
      expect(rowPropsCapture?.allowReselect).toBe(true);
      expect(rowPropsCapture?.onSessionSelected).toBe(nextSelected);
      expect(rowPropsCapture?.isSessionSearchOpen).toBe(true);
      expect(rowPropsCapture?.sessionSearchQuery).toBe('search');
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
      bootstrapState = 'queued';
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
      bootstrapState = null;
      const branched = { ...group, id: 'ci', label: 'ci-delivery', isMain: false, branch: 'ci/role-definition-successor-20260919' };
      for (const [admitted, shown] of [[true, false], [false, true]] as const) {
        useProjectsStore.setState({ managedCatalogAdmitted: admitted, managedCatalogStatus: admitted ? 'ready' : 'stock' });
        await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} group={branched} hideGroupLabel={false} /></I18nProvider>));
        expect(container.textContent?.includes('ci/role-definition-successor-20260919')).toBe(shown);
      }
    } finally {
      bootstrapState = null;
      await act(async () => root.unmount());
      useProjectsStore.setState(original, true);
      useGlobalSessionsStore.setState(originalSessions, true);
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
