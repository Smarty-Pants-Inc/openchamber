import type { SessionGroup } from '../types';

type Section<P> = { project: P; groups: SessionGroup[] };
export type WorkspaceRenderItem<P> = {
  /** Unique render/collapse key; the first item of an unsplit section keeps the project id. */
  key: string;
  /** Header label override; undefined keeps the project's own label. */
  label?: string;
  section: Section<P>;
  split: boolean;
};

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;

/**
 * Herdr parity (smarty-code#126, org's live rule): a checkout shared by several Herdr workspaces shows
 * one TOP-LEVEL group per workspace, labelled exactly, not one joined project with sub-groups. The OC
 * project stays one per checkout; only rendering splits. The workspace whose label names the checkout
 * folder (else the last, Herdr's primary) owns the linked worktree and archived groups.
 */
export function splitSectionsByWorkspace<P extends { id: string; normalizedPath: string }>(
  sections: readonly Section<P>[],
): WorkspaceRenderItem<P>[] {
  return sections.flatMap((section): WorkspaceRenderItem<P>[] => {
    const workspaceGroups = section.groups.filter((group) => group.isMain && group.workspaceId);
    if (workspaceGroups.length < 2) return [{ key: section.project.id, section, split: false }];
    const folder = basename(section.project.normalizedPath);
    const owner = workspaceGroups.find((group) => group.label === folder) ?? workspaceGroups[workspaceGroups.length - 1]!;
    const rest = section.groups.filter((group) => !(group.isMain && group.workspaceId));
    return workspaceGroups.map((group) => ({
      key: group === owner ? section.project.id : `${section.project.id}::workspace:${group.workspaceId}`,
      label: group.label,
      split: true,
      // The workspace's sessions render directly under its own header (a plain root group).
      section: { project: section.project, groups: [{ ...group, workspaceId: undefined }, ...(group === owner ? rest : [])] },
    }));
  });
}
