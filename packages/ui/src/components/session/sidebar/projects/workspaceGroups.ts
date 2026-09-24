import type { SessionGroup } from '../types';

type Workspace = { id: string; label: string };

const workspaceOf = (session: unknown): string | null => {
  const id = (session as { workspaceID?: unknown }).workspaceID;
  return typeof id === 'string' && id ? id : null;
};

/**
 * Herdr parity for a checkout shared by several Herdr workspaces (smarty-code#126): split the
 * project's root group into one labelled group per workspace, holding the sessions whose pane is
 * in it (managed-v1 `session.workspaceID`). A session with no or an unknown workspace stays in the
 * first workspace's group. Worktree and archived groups are unchanged. A new session started from any
 * of these groups targets the shared checkout; its workspace comes from Herdr once its pane exists.
 * ponytail: sub-groups inside one project section (the OC project model is one per checkout);
 * existing folders stay on the first workspace group (Herdr's first workspace), so a foldered session of
 * another workspace shows unfoldered in its own group (the flat view shows every folder);
 * separate top-level sections per workspace would need virtual projects.
 */
export function splitRootGroupByWorkspace(groups: SessionGroup[], workspaces: readonly Workspace[] | undefined): SessionGroup[] {
  if (!workspaces || workspaces.length < 2) return groups;
  const root = groups.find((group) => group.isMain && !group.isArchivedBucket);
  if (!root) return groups;
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const split = workspaces.map((workspace, index): SessionGroup => ({
    ...root,
    id: `workspace:${workspace.id}`,
    label: workspace.label,
    // Still root groups (not worktrees): no PR polling, extra bootstrap demand or sorting.
    isMain: true,
    workspaceId: workspace.id,
    // Folders belong to the first workspace group; the others would repeat them.
    folderScopeKey: index === 0 ? root.folderScopeKey : `${root.folderScopeKey ?? root.directory}#workspace:${workspace.id}`,
    sessions: root.sessions.filter((node) => {
      const id = workspaceOf(node.session);
      return id === workspace.id || (index === 0 && (!id || !known.has(id)));
    }),
  }));
  const at = groups.indexOf(root);
  return [...groups.slice(0, at), ...split, ...groups.slice(at + 1)];
}
