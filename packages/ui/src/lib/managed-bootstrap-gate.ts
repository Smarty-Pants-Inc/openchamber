import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getChatsRootFromDirectory, getReportedChatsRoot } from './chatDirectories';

/**
 * Directory bootstrap admission for a managed catalog (#126 startup 403s). Before discovery answers, every bootstrap
 * waits: the directory in hand may be the home fallback, which a managed gateway refuses. Once the catalog is managed,
 * only its rows and the reported chats root bootstrap; anything else (the home fallback, a removed worktree) is dropped.
 * Stock, unavailable and VS Code runtimes are not gated.
 */
export function managedBootstrapVerdict(directory: string, isVSCode: boolean): 'allow' | 'wait' | 'deny' {
  if (isVSCode) return 'allow';
  const { managedCatalogStatus, managedCatalogAdmitted } = useProjectsStore.getState();
  if (managedCatalogStatus === 'unknown') return 'wait';
  if (!managedCatalogAdmitted) return 'allow';
  const rows = useDirectoryStore.getState().managedDirectories;
  const normalized = normalizePath(directory);
  if (!rows || !normalized) return 'allow';
  if (rows.some((row) => normalizePath(row) === normalized)) return 'allow';
  return getReportedChatsRoot() && getChatsRootFromDirectory(normalized) === getReportedChatsRoot() ? 'allow' : 'deny';
}
