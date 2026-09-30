import React from 'react';
import { setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
import { useLegacySessionProjectViewState } from './useLegacySessionProjectViewState';

type Project = { id: string; sidebarCollapsed?: boolean };
type Args = { isVSCode: boolean; projects: readonly Project[] };

export const useSessionProjectViewState = ({ isVSCode, projects }: Args) => {
  const personal = usePersonalSidebarView();
  const legacy = useLegacySessionProjectViewState({ isVSCode, projects, personal: personal.enabled });
  const collapsedProjects = React.useMemo(() => personal.enabled
    ? new Set(projects.filter(project => personal.projects[project.id] ?? project.sidebarCollapsed ?? false).map(project => project.id))
    : legacy.state.collapsedProjects, [personal.enabled, personal.projects, projects, legacy.state.collapsedProjects]);
  const collapsedGroups = React.useMemo(() => personal.enabled
    ? new Set(Object.keys(personal.groups).filter(key => personal.groups[key]))
    : legacy.state.collapsedGroups, [personal.enabled, personal.groups, legacy.state.collapsedGroups]);
  const latest = React.useRef({ personal, legacy, projects, collapsedProjects, collapsedGroups });
  latest.current = { personal, legacy, projects, collapsedProjects, collapsedGroups };
  // The preference owner rolls back and shows existing localized feedback. UI callbacks do not leak rejected promises.
  const save = React.useCallback((patch: Parameters<typeof setPersonalSidebarView>[0]) => {
    void setPersonalSidebarView(patch).catch(() => undefined);
  }, []);
  const toggleProject = React.useCallback((id: string) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.toggleProject(id);
    save({ projects: { [id]: !view.collapsedProjects.has(id) } });
  }, [save]);
  const toggleGroup = React.useCallback((key: string) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.toggleGroup(key);
    save({ groups: { [key]: !view.collapsedGroups.has(key) } });
  }, [save]);
  const collapseAllProjects = React.useCallback(() => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.collapseAllProjects();
    const groups = Object.fromEntries([...view.collapsedGroups].filter(key => view.projects.some(project => key.startsWith(`${project.id}:`))).map(key => [key, false]));
    save({ projects: Object.fromEntries(view.projects.map(project => [project.id, true])), groups });
  }, [save]);
  const expandAllProjects = React.useCallback(() => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.expandAllProjects();
    const groups = Object.fromEntries([...view.collapsedGroups].filter(key => view.projects.some(project => key.startsWith(`${project.id}:`))).map(key => [key, false]));
    save({ projects: Object.fromEntries(view.projects.map(project => [project.id, false])), groups });
  }, [save]);
  const setCollapsedProjects = React.useCallback<React.Dispatch<React.SetStateAction<Set<string>>>>(update => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.setCollapsedProjects(update);
    const next = update instanceof Set ? update : update(view.collapsedProjects);
    save({ projects: Object.fromEntries(view.projects.filter(project => next.has(project.id) !== view.collapsedProjects.has(project.id))
      .map(project => [project.id, next.has(project.id)])) });
  }, [save]);
  const setCollapsedGroups = React.useCallback<React.Dispatch<React.SetStateAction<Set<string>>>>(update => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.setCollapsedGroups(update);
    const next = update instanceof Set ? update : update(view.collapsedGroups);
    const keys = new Set([...next, ...view.collapsedGroups]);
    save({ groups: Object.fromEntries([...keys].filter(key => next.has(key) !== view.collapsedGroups.has(key)).map(key => [key, next.has(key)])) });
  }, [save]);
  const scheduleCollapsedProjectsPersist = React.useCallback((next: Set<string>) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.scheduleCollapsedProjectsPersist(next);
    setCollapsedProjects(next);
  }, [setCollapsedProjects]);
  const state = React.useMemo(() => ({ collapsedProjects, collapsedGroups, groupOrderByProject: legacy.state.groupOrderByProject }),
    [collapsedProjects, collapsedGroups, legacy.state.groupOrderByProject]);
  const actions = React.useMemo(() => ({
    setCollapsedProjects, toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist,
    setCollapsedGroups, toggleGroup, setGroupOrderByProject: legacy.actions.setGroupOrderByProject, getOrderedGroups: legacy.actions.getOrderedGroups,
  }), [setCollapsedProjects, toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist,
    setCollapsedGroups, toggleGroup, legacy.actions.setGroupOrderByProject, legacy.actions.getOrderedGroups]);
  return { state, actions };
};
