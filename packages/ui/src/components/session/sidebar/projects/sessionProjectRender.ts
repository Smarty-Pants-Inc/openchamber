import type { SessionGroup } from '../types';

export type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
    icon?: string;
    color?: string;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    iconBackground?: string;
  };
  groups: SessionGroup[];
};

export const selectRenderedProjectSections = (
  sections: ProjectSection[],
  singleProjectMode: boolean,
  singleProjectId: string | null,
): ProjectSection[] => singleProjectMode
  ? sections.filter((section) => section.project.id === singleProjectId)
  : sections;

/**
 * What the sidebar shows when a search leaves no project section to render.
 *
 * The managed chats live in the scroller's top content rather than in a project
 * section, so a query that matches only a chat empties `sectionsForRender` while
 * a real result is still on screen above it. Answering `top-content` there keeps
 * that result visible; answering `empty-state` before checking it hid the chat
 * and claimed nothing matched, while the header counted the match (issue #3200).
 */
export const resolveSearchResultPlacement = (
  topContentHasSearchMatches: boolean,
): 'top-content' | 'empty-state' => topContentHasSearchMatches ? 'top-content' : 'empty-state';

type GroupRenderDescriptor = {
  group: SessionGroup;
  groupKey: string;
  projectId: string;
  hideGroupLabel: boolean;
};

export const buildGroupRenderDescriptors = (
  section: ProjectSection,
  options: { mainWorkspaceOnly: boolean },
): GroupRenderDescriptor[] => {
  const primaryGroup = section.groups.find((group) => group.isMain && group.sessions.length > 0)
    ?? section.groups.find((group) => group.sessions.length > 0)
    ?? section.groups.find((group) => group.isMain)
    ?? section.groups[0];
  if (!primaryGroup) return [];

  const archivedGroup = section.groups.find((group) => group.isArchivedBucket && group.id !== primaryGroup.id);
  // A shared checkout splits its root into labelled workspace groups; all of them are the root.
  const workspaceGroups = section.groups.filter((group) => group.isMain && group.workspaceId);
  const rootGroups = workspaceGroups.length > 0 ? workspaceGroups : section.groups.filter((group) => group.isMain).slice(0, 1);
  const groups = options.mainWorkspaceOnly
    ? [...(workspaceGroups.length > 0 ? workspaceGroups : [primaryGroup]), ...(archivedGroup ? [archivedGroup] : [])]
    : [...rootGroups, ...section.groups.filter((group) => !group.isMain)];

  return groups.map((group) => ({
    group,
    groupKey: `${section.project.id}:${group.id}`,
    projectId: section.project.id,
    hideGroupLabel: group.workspaceId ? false
      : options.mainWorkspaceOnly ? group.id === primaryGroup.id : group.isMain,
  }));
};
