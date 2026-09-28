import path from 'node:path';

/**
 * Where "+ New" creates a managed worktree (smarty-code#629). Stock OpenChamber: `<data>/opencode/worktree/<project id>/`.
 * OPENCHAMBER_WORKTREE_ROOT (like OPENCHAMBER_CHATS_DIR) moves it to `<root>/<repository folder name>/`, so a host can keep
 * new worktrees beside the ones its other tools make (Smarty Code: Herdr's `~/.herdr/worktrees/<repo>/`, a root its
 * gateway admits). Unset or blank: the stock path.
 */
export function managedWorktreeRoot({ dataPath, projectID, primaryWorktree, env = process.env }) {
  const root = typeof env.OPENCHAMBER_WORKTREE_ROOT === 'string' ? env.OPENCHAMBER_WORKTREE_ROOT.trim() : '';
  if (!root) return path.join(dataPath, 'worktree', projectID);
  return path.join(path.resolve(root), path.basename(path.resolve(primaryWorktree)));
}
