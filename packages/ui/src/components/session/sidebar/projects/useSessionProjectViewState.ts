import React from 'react';
import { isPersonalSidebarAdmissionCurrent, setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
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
  const save = React.useCallback((patch: Parameters<typeof setPersonalSidebarView>[0], admission: symbol) => {
    void setPersonalSidebarView(patch, admission).catch(() => undefined);
  }, []);
  const toggleProject = React.useCallback((id: string) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.toggleProject(id);
    save({ projects: { [id]: !view.collapsedProjects.has(id) } }, view.personal.admission);
  }, [save]);
  const toggleGroup = React.useCallback((key: string) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.toggleGroup(key);
    save({ groups: { [key]: !view.collapsedGroups.has(key) } }, view.personal.admission);
  }, [save]);
  const collapseAllProjects = React.useCallback(() => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.collapseAllProjects();
    if (!view.personal.ready || !isPersonalSidebarAdmissionCurrent(view.personal.admission)) return;
    const groups = Object.fromEntries([...view.collapsedGroups].filter(key => view.projects.some(project => key.startsWith(`${project.id}:`))).map(key => [key, false]));
    save({ projects: Object.fromEntries(view.projects.map(project => [project.id, true])), groups }, view.personal.admission);
  }, [save]);
  const expandAllProjects = React.useCallback(() => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.expandAllProjects();
    if (!view.personal.ready || !isPersonalSidebarAdmissionCurrent(view.personal.admission)) return;
    const groups = Object.fromEntries([...view.collapsedGroups].filter(key => view.projects.some(project => key.startsWith(`${project.id}:`))).map(key => [key, false]));
    save({ projects: Object.fromEntries(view.projects.map(project => [project.id, false])), groups }, view.personal.admission);
  }, [save]);
  const setCollapsedProjects = React.useCallback<React.Dispatch<React.SetStateAction<Set<string>>>>(update => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.setCollapsedProjects(update);
    if (!view.personal.ready || !isPersonalSidebarAdmissionCurrent(view.personal.admission)) return;
    const next = update instanceof Set ? update : update(view.collapsedProjects);
    save({ projects: Object.fromEntries(view.projects.filter(project => next.has(project.id) !== view.collapsedProjects.has(project.id))
      .map(project => [project.id, next.has(project.id)])) }, view.personal.admission);
  }, [save]);
  const setCollapsedGroups = React.useCallback<React.Dispatch<React.SetStateAction<Set<string>>>>(update => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.setCollapsedGroups(update);
    if (!view.personal.ready || !isPersonalSidebarAdmissionCurrent(view.personal.admission)) return;
    const next = update instanceof Set ? update : update(view.collapsedGroups);
    const keys = new Set([...next, ...view.collapsedGroups]);
    save({ groups: Object.fromEntries([...keys].filter(key => next.has(key) !== view.collapsedGroups.has(key)).map(key => [key, next.has(key)])) }, view.personal.admission);
  }, [save]);
  const scheduleCollapsedProjectsPersist = React.useCallback((next: Set<string>) => {
    const view = latest.current;
    if (!view.personal.enabled) return view.legacy.actions.scheduleCollapsedProjectsPersist(next);
    if (!view.personal.ready || !isPersonalSidebarAdmissionCurrent(view.personal.admission)) return;
    setCollapsedProjects(next);
  }, [setCollapsedProjects]);
  const state = React.useMemo(() => ({ collapsedProjects, collapsedGroups, groupOrderByProject: legacy.state.groupOrderByProject }),
    [collapsedProjects, collapsedGroups, legacy.state.groupOrderByProject]);
  const actions = React.useMemo(() => ({
    setCollapsedProjects, toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist,
    setCollapsedGroups, toggleGroup, setGroupOrderByProject: legacy.actions.setGroupOrderByProject, getOrderedGroups: legacy.actions.getOrderedGroups,
  }), [setCollapsedProjects, toggleProject, collapseAllProjects, expandAllProjects, scheduleCollapsedProjectsPersist,
    setCollapsedGroups, toggleGroup, legacy.actions.setGroupOrderByProject, legacy.actions.getOrderedGroups]);
  const currentAdmission = isPersonalSidebarAdmissionCurrent(personal.admission);
  return { state, actions, bulkActionsReady: !personal.enabled || (personal.ready && currentAdmission) };
};
