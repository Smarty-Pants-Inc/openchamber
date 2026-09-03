import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { installHookTestDom } from '../test-utils/testDom';

type SortableProjectItemCapture = {
  id: string;
  disabled?: boolean;
  onClose?: () => void;
};

const projectItemCaptures: SortableProjectItemCapture[] = [];

mock.module('./sortableItems', () => ({
  SortableProjectItem: (props: SortableProjectItemCapture & { children?: React.ReactNode }) => {
    projectItemCaptures.push({ id: props.id, disabled: props.disabled, onClose: props.onClose });
    return <div data-project-item={props.id}>{props.children}</div>;
  },
  SortableGroupItem: ({ children }: { children: (dragHandleProps: unknown) => React.ReactNode }) => (
    <>{children({ listeners: {}, setActivatorNodeRef: () => undefined })}</>
  ),
  ProjectHeaderIdentity: () => null,
}));

mock.module('./SessionGroupSection', () => ({
  SessionGroupSection: () => null,
}));
// The hook-test DOM stub cannot back ScrollableOverlay's shadow-measurement
// effects; the scroller's gating logic does not depend on it.
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const { SessionProjectScroller } = await import('./SessionProjectScroller');

type ScrollerProps = React.ComponentProps<typeof SessionProjectScroller>;

const projectSection = (id: string) => ({
  project: { id, normalizedPath: `/workspace/${id}` },
  groups: [],
});

const createModel = (): ScrollerProps['model'] => ({
  sectionsForRender: [projectSection('project-a'), projectSection('project-b')],
  projectSections: [projectSection('project-a'), projectSection('project-b')],
  activeProjectId: 'project-a',
  singleProjectMode: false,
  singleProjectId: null,
  emptyState: null,
  searchEmptyState: null,
  projectRepoStatus: new Map(),
  stuckProjectHeaders: new Set(),
  projectHeaderSentinelRefs: { current: new Map() },
  state: {
    editingId: null,
    openSidebarMenuKey: null,
    setOpenSidebarMenuKey: () => undefined,
    visibleSessionCountByGroup: new Map(),
  },
  groupProps: {
    hasSessionSearchQuery: false,
    normalizedSessionSearchQuery: '',
    groupSearchDataByGroup: new WeakMap(),
    collapsedGroups: new Set(),
    hideDirectoryControls: false,
    mobileVariant: false,
    alwaysShowActions: false,
    activeProjectId: null,
    notifyOnSubtasks: false,
    expandedParents: new Set(),
    editTitle: '',
    copiedSessionId: null,
    folderRename: null,
    setFolderRenameDraft: () => undefined,
    clearFolderRename: () => undefined,
    setEditingId: () => undefined,
    setEditTitle: () => undefined,
    toggleParent: () => undefined,
    allowReselect: false,
    onSessionSelected: () => undefined,
    isSessionSearchOpen: false,
    sessionSearchQuery: '',
    setSessionSearchQuery: () => undefined,
    setIsSessionSearchOpen: () => undefined,
    deleteSessionConfirm: null,
    setDeleteSessionConfirm: () => undefined,
    startFolderRename: () => undefined,
    setCopiedSessionId: () => undefined,
    pinnedSessionIds: new Set(),
    sessionOrderIndex: new Map(),
  },
});

const createView = (runtimeProjectMembershipActive: boolean): ScrollerProps['view'] => ({
  homeDirectory: null,
  collapsedProjects: new Set(),
  showOnlyMainWorkspace: false,
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  hideDirectoryControls: false,
  isDesktopShellRuntime: false,
  stickyZoneHeaders: false,
  mobileVariant: false,
  alwaysShowActions: false,
  projectSortOrder: 'manual',
  runtimeProjectMembershipActive,
});

const createActions = (): ScrollerProps['actions'] => ({
  group: {
    showMoreGroupSessions: () => undefined,
    resetGroupSessionLimit: () => undefined,
    setActiveProjectIdOnly: () => undefined,
    setSessionSwitcherOpen: () => undefined,
    openNewSessionDraft: () => undefined,
    onToggleCollapsedGroup: () => undefined,
  },
  toggleProject: () => undefined,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  openNewWorktreeDialog: () => undefined,
  openWorktreesPage: () => undefined,
  openProjectEditDialog: () => undefined,
  removeProject: () => undefined,
  reorderProjects: () => undefined,
  setGroupOrderByProject: () => undefined,
  setSingleProjectId: () => undefined,
});

describe('SessionProjectScroller runtime membership gating', () => {
  test('keeps close and drag enabled when settings own membership', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    projectItemCaptures.length = 0;

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionProjectScroller model={createModel()} view={createView(false)} actions={createActions()} />
        </I18nProvider>,
      ));

      expect(projectItemCaptures.length).toBe(2);
      for (const capture of projectItemCaptures) {
        expect(capture.disabled).toBe(false);
        expect(typeof capture.onClose).toBe('function');
      }
    } finally {
      await act(async () => root.unmount());
      projectItemCaptures.length = 0;
      dom.restore();
    }
  });

  test('disables close and drag when the runtime owns membership', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    projectItemCaptures.length = 0;

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionProjectScroller model={createModel()} view={createView(true)} actions={createActions()} />
        </I18nProvider>,
      ));

      expect(projectItemCaptures.length).toBe(2);
      for (const capture of projectItemCaptures) {
        expect(capture.disabled).toBe(true);
        expect(capture.onClose).toBe(undefined);
      }
    } finally {
      await act(async () => root.unmount());
      projectItemCaptures.length = 0;
      dom.restore();
    }
  });
});
