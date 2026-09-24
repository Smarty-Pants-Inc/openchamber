import type { SessionGroup } from '../types';

type Section<P> = { project: P; groups: SessionGroup[] };
export type WorkspaceRenderItem<P> = {
  /** Render and collapse key: the project id. */
  key: string;
  /** Header label override; undefined keeps the project's own label. */
  label?: string;
  section: Section<P>;
};

/**
 * Herdr parity (smarty-code#126 5809353823, Herdr `workspace_entries` in `src/client/shell/sidebar.rs`): the
 * workspaces of one repository form one block. Its head is the first non-linked workspace in Herdr order; every
 * other member, the checkout's other workspaces and each linked worktree, is a child in Herdr order. For a checkout
 * shared by several workspaces, the head workspace labels the project header and its sessions are the header's
 * own rows; the other workspaces stay labelled child groups, before the linked worktree groups.
 * ponytail: the catalog gives Herdr order within a checkout (`workspaces`) and across rows, not one order across
 * both, so the checkout's other workspaces are placed before its worktrees. That matches Herdr while they were
 * opened first (true for smarty-dev today); revisit if the catalog publishes a block-wide order.
 */
export function nestSharedCheckout<P extends { id: string }>(sections: readonly Section<P>[]): WorkspaceRenderItem<P>[] {
  return sections.map((section): WorkspaceRenderItem<P> => {
    const workspaceGroups = section.groups.filter((group) => group.isMain && group.workspaceId);
    if (workspaceGroups.length < 2) return { key: section.project.id, section };
    const head = workspaceGroups[0]!;
    return {
      key: section.project.id,
      label: head.label,
      section: { project: section.project, groups: section.groups.map((group) => group === head ? { ...group, workspaceId: undefined } : group) },
    };
  });
}
