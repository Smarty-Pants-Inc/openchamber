import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { ChildStoreManager } from '@/sync/child-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { FilesystemError } from '@/lib/api/files-errors';
import { installHookTestDom } from '../test-utils/testDom';
import type { SessionGroup } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { useSidebarGroupStatus } from './useSidebarGroupStatus';
import { buildSessionSidebarRowModel } from '../sessionSidebarRowModel';

const sections: ProjectSection[] = [];
const chatGroup: SessionGroup = {
  id: 'managed-chats', label: '', branch: null, description: null, isMain: true,
  worktree: null, directory: '/chats', folderScopeKey: '/chats', sessions: [],
  folderScopes: [{ scopeKey: '/chats', directory: '/chats' }, { scopeKey: '/chats/session', directory: '/chats/session' }],
};

for (const failure of ['load-failed', 'initialization-failed', 'permission-denied'] as const) {
  test(`a Chats-only sidebar observes ${failure} and a successful retry`, async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const manager = new ChildStoreManager();
    const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
    let renders = 0;
    let fail = true;
    manager.configure({ onBootstrap: (context) => {
      if (!fail) { context.trackInitialization(Promise.resolve()); return; }
      if (failure === 'load-failed') throw new Error('list failed');
      const error = failure === 'permission-denied'
        ? new FilesystemError('Access denied', { reason: 'os-permission' })
        : new Error('initialization failed');
      context.trackInitialization(Promise.reject(error));
    } });
    const Harness = ({ nativeAccess = true }: { nativeAccess?: boolean }) => {
      renders += 1;
      captured.current = useSidebarGroupStatus({ childStores: manager, sections, chatGroup, canGrantAccess: nativeAccess });
      return null;
    };
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => manager.requestBootstrap({ directory: '/chats/session', priority: 'selected', reason: 'selected-session' }));
      expect(captured.current?.groupStatusByKey.get('activity:chats')).toEqual({
        state: failure, directory: '/chats/session', canGrantAccess: failure === 'permission-denied',
      });
      await act(async () => root.render(<Harness nativeAccess={false} />));
      expect(captured.current?.groupStatusByKey.get('activity:chats')?.canGrantAccess).toBe(false);

      const previousRenders = renders;
      await act(async () => manager.requestBootstrap({ directory: '/unrelated', priority: 'selected', reason: 'selected-session' }));
      expect(renders).toBe(previousRenders);
      fail = false;
      await act(async () => manager.requestBootstrap({ directory: '/chats/session', priority: 'expanded', reason: 'project-expanded', force: true }));
      expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('ready');
    } finally {
      await act(async () => root.unmount());
      manager.disposeAll();
      dom.restore();
    }
  });
}

test('managed known-empty roots stop loading only after both catalog and global list have answered', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  const originalProjects = useProjectsStore.getState();
  const originalSessions = useGlobalSessionsStore.getState();
  manager.configure({ onBootstrap: () => undefined });
  manager.setBootstrapGate(() => 'wait');
  manager.requestBootstrap({ directory: '/root', priority: 'selected', reason: 'selected-session' });
  const group: SessionGroup = { ...chatGroup, id: 'main', directory: '/root', folderScopes: [{ scopeKey: '/root', directory: '/root' }] };
  const projectSections: ProjectSection[] = [{ project: { id: 'p', normalizedPath: '/root' }, groups: [group] }];
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections: projectSections, chatGroup: null, canGrantAccess: false });
    return null;
  };
  try {
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unknown' });
    useGlobalSessionsStore.setState({ hasLoaded: false });
    await act(async () => root.render(<Harness />));
    expect(manager.getBootstrapState('/root')).toBe('queued');
    expect(captured.current?.groupStatusByKey.get('p:main')?.state).toBe('loading');
    await act(async () => useProjectsStore.setState({ managedCatalogStatus: 'ready' }));
    expect(captured.current?.groupStatusByKey.get('p:main')?.state).toBe('loading');
    await act(async () => useGlobalSessionsStore.setState({ hasLoaded: true }));
    expect(manager.getBootstrapState('/root')).toBe('queued');
    expect(captured.current?.groupStatusByKey.get('p:main')?.state).toBe('ready');
    await act(async () => useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' }));
    expect(captured.current?.groupStatusByKey.get('p:main')?.state).toBe('loading');
  } finally {
    await act(async () => root.unmount());
    manager.disposeAll();
    useProjectsStore.setState(originalProjects, true);
    useGlobalSessionsStore.setState(originalSessions, true);
    dom.restore();
  }
});

for (const failure of ['load-failed', 'initialization-failed', 'permission-denied'] as const) {
  test(`managed global coverage does not hide ${failure} on a root with stale sessions`, async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const manager = new ChildStoreManager();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = useGlobalSessionsStore.getState();
    const group: SessionGroup = { ...chatGroup, id: 'main', directory: '/root', folderScopes: [{ scopeKey: '/root', directory: '/root' }], sessions: [{
      session: { id: 'stale', title: 'Retained session', projectID: 'p', directory: '/root', slug: 'stale', version: '1', time: { created: 1, updated: 1 } },
      children: [], worktree: null,
    }] };
    const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
    manager.configure({ onBootstrap: (context) => {
      if (failure === 'load-failed') throw new Error('list failed');
      context.trackInitialization(Promise.reject(failure === 'permission-denied'
        ? new FilesystemError('Access denied', { reason: 'os-permission' }) : new Error('initialization failed')));
    } });
    const Harness = () => {
      captured.current = useSidebarGroupStatus({ childStores: manager, sections: [{ project: { id: 'p', normalizedPath: '/root' }, groups: [group] }], chatGroup: null, canGrantAccess: true });
      return null;
    };
    try {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready' });
      useGlobalSessionsStore.setState({ hasLoaded: true });
      await act(async () => root.render(<Harness />));
      await act(async () => manager.requestBootstrap({ directory: '/root', priority: 'selected', reason: 'selected-session' }));
      expect(captured.current?.groupStatusByKey.get('p:main')).toEqual({ state: failure, directory: '/root', canGrantAccess: failure === 'permission-denied' });
      const section = { project: { id: 'p', normalizedPath: '/root' }, groups: [group] };
      const rows = buildSessionSidebarRowModel({
        mode: 'normal', sections: [section], authoritativeSections: [section], chatGroup: null, recentSections: [], showRecentSection: false,
        foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '', collapsedProjects: new Set(), collapsedGroups: new Set(),
        collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(), visibleCountByContainer: new Map(),
        pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey: captured.current!.groupStatusByKey, folderAuthorityByOwner: new Map(),
        activeProjectId: 'p', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
      });
      expect(rows.rows.flatMap((row) => row.kind === 'session' ? [row.node.session.id] : [])).toEqual(['stale']);
      expect(rows.rows.flatMap((row) => row.kind === 'status' ? [row.status.state] : [])).toEqual([failure]);
      expect(rows.rows.some((row) => row.kind === 'empty')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      manager.disposeAll();
      useProjectsStore.setState(originalProjects, true);
      useGlobalSessionsStore.setState(originalSessions, true);
      dom.restore();
    }
  });
}

test('Chats loading ends when its list completes, without waiting for initialization', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  let resolveList: () => void = () => undefined;
  let resolveInitialization: () => void = () => undefined;
  const list = new Promise<void>((resolve) => { resolveList = resolve; });
  const initialization = new Promise<void>((resolve) => { resolveInitialization = resolve; });
  manager.configure({ onBootstrap: (context) => { context.trackInitialization(initialization); return list; } });
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections, chatGroup, canGrantAccess: false });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => manager.requestBootstrap({ directory: '/chats', priority: 'selected', reason: 'selected-session' }));
    expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('loading');
    await act(async () => resolveList());
    expect(manager.getInitializationState('/chats')).toBe('running');
    expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('ready');
  } finally {
    await act(async () => { resolveList(); resolveInitialization(); root.unmount(); });
    manager.disposeAll();
    dom.restore();
  }
});
