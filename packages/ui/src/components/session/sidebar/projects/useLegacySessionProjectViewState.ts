import React from 'react';
import { updateDesktopSettings } from '@/lib/persistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { z } from 'zod';
import { useGroupOrdering } from './useGroupOrdering';

const PROJECT_KEY = 'oc.sessions.projectCollapse';
const GROUP_KEY = 'oc.sessions.groupCollapse';
const ORDER_KEY = 'oc.sessions.groupOrder';
const parseSet = (raw: string | null): Set<string> => {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw ?? 'null'));
    return new Set(parsed.success ? parsed.data : []);
  } catch { return new Set(); }
};
const parseOrder = (raw: string | null): Map<string, string[]> => {
  try {
    const parsed = z.record(z.string(), z.array(z.string())).safeParse(JSON.parse(raw ?? 'null'));
    return new Map(parsed.success ? Object.entries(parsed.data) : []);
  } catch { return new Map(); }
};

/** Legacy and VS Code storage/writes are deliberately separate from human preferences. */
export function useLegacySessionProjectViewState({ isVSCode, projects, personal }: {
  isVSCode: boolean; projects: readonly { id: string }[]; personal: boolean;
}) {
  const storage = React.useMemo(() => getDeferredSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState(() => personal ? new Set<string>() : parseSet(storage.getItem(PROJECT_KEY)));
  const [collapsedGroups, setCollapsedGroups] = React.useState(() => personal ? new Set<string>() : parseSet(storage.getItem(GROUP_KEY)));
  const [groupOrderByProject, setGroupOrderByProject] = React.useState(() => parseOrder(storage.getItem(ORDER_KEY)));
  const wasPersonal = React.useRef(personal);
  React.useEffect(() => {
    if (wasPersonal.current && !personal) {
      setCollapsedProjects(parseSet(storage.getItem(PROJECT_KEY)));
      setCollapsedGroups(parseSet(storage.getItem(GROUP_KEY)));
    }
    wasPersonal.current = personal;
  }, [personal, storage]);
  const groupDirty = React.useRef(false);
  const orderDirty = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<Set<string> | null>(null);
  const flush = React.useCallback(() => {
    const collapsed = pending.current;
    pending.current = null; timer.current = null;
    if (!collapsed || isVSCode || personal) return;
    const { projects: storedProjects } = useProjectsStore.getState();
    void updateDesktopSettings({ projects: storedProjects.map(project => ({ ...project, sidebarCollapsed: collapsed.has(project.id) })) },
      { expectedProjects: storedProjects }).catch(() => {});
  }, [isVSCode, personal]);
  const scheduleCollapsedProjectsPersist = React.useCallback((collapsed: Set<string>) => {
    if (!globalThis.window || isVSCode || personal) return;
    pending.current = collapsed;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  }, [flush, isVSCode, personal]);
  React.useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null; pending.current = null;
  }, [personal]);
  React.useEffect(() => {
    if (!orderDirty.current) return;
    storage.setItem(ORDER_KEY, JSON.stringify(Object.fromEntries(groupOrderByProject)));
  }, [groupOrderByProject, storage]);
  React.useEffect(() => {
    if (!groupDirty.current || personal) return;
    storage.setItem(GROUP_KEY, JSON.stringify(Array.from(collapsedGroups)));
  }, [collapsedGroups, personal, storage]);
  const applyProjects = React.useCallback((next: Set<string>) => {
    storage.setItem(PROJECT_KEY, JSON.stringify(Array.from(next)));
    scheduleCollapsedProjectsPersist(next);
    return next;
  }, [scheduleCollapsedProjectsPersist, storage]);
  const collapseAllProjects = React.useCallback(() => {
    groupDirty.current = true; setCollapsedGroups(new Set());
    setCollapsedProjects(() => applyProjects(new Set(projects.map(project => project.id))));
  }, [applyProjects, projects]);
  const expandAllProjects = React.useCallback(() => {
    groupDirty.current = true; setCollapsedGroups(new Set());
    setCollapsedProjects(() => applyProjects(new Set()));
  }, [applyProjects]);
  const toggleProject = React.useCallback((id: string) => setCollapsedProjects(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return applyProjects(next);
  }), [applyProjects]);
  const toggleGroup = React.useCallback((key: string) => {
    groupDirty.current = true;
    setCollapsedGroups(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const updateGroupOrder = React.useCallback<React.Dispatch<React.SetStateAction<Map<string, string[]>>>>(update => {
    orderDirty.current = true; setGroupOrderByProject(update);
  }, []);
  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  const state = React.useMemo(() => ({ collapsedProjects, collapsedGroups, groupOrderByProject }), [collapsedProjects, collapsedGroups, groupOrderByProject]);
  const actions = React.useMemo(() => ({
    setCollapsedProjects, toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist,
    setCollapsedGroups, toggleGroup, setGroupOrderByProject: updateGroupOrder, getOrderedGroups,
  }), [toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist, toggleGroup, updateGroupOrder, getOrderedGroups]);
  return { state, actions };
}
