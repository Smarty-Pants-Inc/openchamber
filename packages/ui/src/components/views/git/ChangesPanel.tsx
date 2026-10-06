import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from '@/components/icon/Icon';
import { ChangeRow } from './ChangeRow';
import {
  TREE_INDENT_PX,
  buildChangesTree,
  flattenChangesTree,
  type ChangesTreeDirectoryNode,
  type FlattenedTreeRow,
} from './changesTree';
import type { GitStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

export interface ChangesGroupConfig {
  /** Stable id (e.g. 'staged' | 'unstaged'). */
  id: string;
  title: string;
  entries: GitStatus['files'];
  onViewDiff: (path: string) => void;
}

interface ChangesPanelProps {
  groups: ChangesGroupConfig[];
  diffStats: Record<string, { insertions: number; deletions: number }> | undefined;
  headerBackgroundClassName?: string;
  onVisiblePathsChange?: (paths: string[]) => void;
}

const CHANGE_LIST_VIRTUALIZE_THRESHOLD = 1000;
const CHANGE_ROW_ESTIMATE_PX = 34;
const VISIBLE_PREFETCH_LIMIT = 30;

const ROW_PADDING_CLASSNAME = 'pl-0 pr-2';

type PanelRow =
  | { type: 'header'; key: string; groupIndex: number }
  | { type: 'file'; key: string; groupIndex: number; file: GitStatus['files'][number]; depth: number }
  | { type: 'directory'; key: string; groupIndex: number; directory: ChangesTreeDirectoryNode; depth: number };

const expandedKey = (groupId: string, path: string): string => `${groupId} ${path}`;

export const ChangesPanel: React.FC<ChangesPanelProps> = ({
  groups,
  diffStats,
  headerBackgroundClassName = 'bg-sidebar',
  onVisiblePathsChange,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const isTreeView = gitChangesViewMode === 'tree';

  const visibleGroups = React.useMemo(() => groups.filter((group) => group.entries.length > 0), [groups]);

  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = React.useState<Set<string>>(new Set());

  const trees = React.useMemo(
    () => visibleGroups.map((group) => buildChangesTree(group.entries)),
    [visibleGroups]
  );

  // Auto-expand every top-level directory the first time it appears (mirrors prior
  // ChangesSection behavior) while preserving user-collapsed nested directories.
  const topLevelDirectoryKeys = React.useMemo(() => {
    const keys: string[] = [];
    visibleGroups.forEach((group, index) => {
      Array.from(trees[index]?.children.values() ?? []).forEach((directory) => {
        keys.push(expandedKey(group.id, directory.path));
      });
    });
    return keys;
  }, [trees, visibleGroups]);

  React.useEffect(() => {
    if (!isTreeView) {
      return;
    }
    setExpandedDirectories((previous) => {
      const next = new Set<string>();
      const topLevel = new Set(topLevelDirectoryKeys);
      previous.forEach((key) => {
        const path = key.slice(key.indexOf(' ') + 1);
        if (path.includes('/') || topLevel.has(key)) {
          next.add(key);
        }
      });
      topLevelDirectoryKeys.forEach((key) => next.add(key));
      return next;
    });
  }, [isTreeView, topLevelDirectoryKeys]);

  const rows = React.useMemo<PanelRow[]>(() => {
    const result: PanelRow[] = [];

    visibleGroups.forEach((group, groupIndex) => {
      result.push({ type: 'header', key: `header:${group.id}`, groupIndex });

      if (collapsedGroups.has(group.id)) {
        return;
      }

      if (isTreeView) {
        const expandedForGroup = new Set<string>();
        expandedDirectories.forEach((key) => {
          if (key.startsWith(`${group.id} `)) {
            expandedForGroup.add(key.slice(group.id.length + 1));
          }
        });
        const treeRows = flattenChangesTree(trees[groupIndex], expandedForGroup);
        treeRows.forEach((row: FlattenedTreeRow) => {
          if (row.kind === 'file') {
            result.push({
              type: 'file',
              key: `${group.id}:${row.key}`,
              groupIndex,
              file: row.file,
              depth: row.depth,
            });
          } else {
            result.push({
              type: 'directory',
              key: `${group.id}:${row.key}`,
              groupIndex,
              directory: row.directory,
              depth: row.depth,
            });
          }
        });
        return;
      }

      group.entries.forEach((file) => {
        result.push({
          type: 'file',
          key: `${group.id}:file:${file.path}`,
          groupIndex,
          file,
          depth: 0,
        });
      });
    });

    return result;
  }, [collapsedGroups, expandedDirectories, isTreeView, trees, visibleGroups]);

  const rowCount = rows.length;
  const shouldVirtualize = rowCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANGE_ROW_ESTIMATE_PX,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  // First VISIBLE row index drives the visible-path prefetch window (the
  // virtua findItemIndex/onScroll pair this replaces). virtualRows starts at
  // the overscan boundary — up to `overscan` rows above the viewport — so
  // skip rows that end above the current scroll offset; otherwise the
  // prefetch budget leaks to offscreen files above the viewport.
  const visibleStartIndex = React.useMemo(() => {
    if (!shouldVirtualize) return 0;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const firstVisible = virtualRows.find((item) => item.end > scrollTop);
    return firstVisible?.index ?? 0;
  }, [shouldVirtualize, virtualRows, scrollRef]);

  React.useEffect(() => {
    if (!onVisiblePathsChange) {
      return;
    }

    const collectFromRow = (row: PanelRow | undefined): string | null =>
      row && row.type === 'file' ? row.file.path : null;

    if (rowCount === 0) {
      onVisiblePathsChange([]);
      return;
    }

    if (!shouldVirtualize) {
      const paths: string[] = [];
      for (const row of rows) {
        if (row.type === 'file') {
          paths.push(row.file.path);
          if (paths.length >= VISIBLE_PREFETCH_LIMIT) break;
        }
      }
      onVisiblePathsChange(paths);
      return;
    }

    onVisiblePathsChange(
      rows
        .slice(
          visibleStartIndex,
          visibleStartIndex + Math.ceil((scrollRef.current?.clientHeight ?? 0) / CHANGE_ROW_ESTIMATE_PX) + VISIBLE_PREFETCH_LIMIT
        )
        .map((row) => collectFromRow(row))
        .filter((value): value is string => Boolean(value))
        .slice(0, VISIBLE_PREFETCH_LIMIT)
    );
  }, [onVisiblePathsChange, rowCount, rows, shouldVirtualize, visibleStartIndex]);

  const toggleGroupCollapsed = React.useCallback((groupId: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleDirectoryExpanded = React.useCallback((groupId: string, path: string) => {
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      const key = expandedKey(groupId, path);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const renderHeader = React.useCallback(
    (group: ChangesGroupConfig, isFirst: boolean) => {
      const collapsed = collapsedGroups.has(group.id);
      const count = group.entries.length;
      return (
        <div
          className={cn(
            'sticky top-0 z-10 flex items-center gap-2 py-2',
            headerBackgroundClassName,
            ROW_PADDING_CLASSNAME,
            !isFirst && 'mt-1 border-t border-border/40'
          )}
        >
          <button
            type="button"
            onClick={() => toggleGroupCollapsed(group.id)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-expanded={!collapsed}
          >
            <h3 className="truncate typography-ui-header font-semibold text-foreground">{group.title}</h3>
            <span className="typography-meta text-muted-foreground">{count}</span>
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                collapsed && '-rotate-90'
              )}
            />
          </button>
        </div>
      );
    },
    [collapsedGroups, headerBackgroundClassName, toggleGroupCollapsed]
  );

  const renderDirectory = React.useCallback(
    (group: ChangesGroupConfig, directory: ChangesTreeDirectoryNode, depth: number) => {
      const isExpanded = expandedDirectories.has(expandedKey(group.id, directory.path));
      return (
        <div
          className={cn('group flex items-center gap-2 py-1.5', ROW_PADDING_CLASSNAME)}
          style={{ paddingLeft: `${depth * TREE_INDENT_PX}px` }}
        >
          <button
            type="button"
            onClick={() => toggleDirectoryExpanded(group.id, directory.path)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={
              isExpanded
                ? t('gitView.changes.collapseDirectoryAria', { path: directory.path })
                : t('gitView.changes.expandDirectoryAria', { path: directory.path })
            }
          >
            {isExpanded ? (
              <Icon name="folder-open-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
            ) : (
              <Icon name="folder-3-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
            )}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={directory.path}>
              {directory.name}
            </span>
            <span className="ml-auto shrink-0 typography-micro text-muted-foreground">{directory.files.length}</span>
          </button>
        </div>
      );
    },
    [expandedDirectories, t, toggleDirectoryExpanded]
  );

  const renderRow = React.useCallback(
    (row: PanelRow, isFirstRow: boolean) => {
      const group = visibleGroups[row.groupIndex];
      if (!group) return null;

      if (row.type === 'header') {
        return renderHeader(group, isFirstRow);
      }

      if (row.type === 'directory') {
        return renderDirectory(group, row.directory, row.depth);
      }

      const file = row.file;
      return (
        <ChangeRow
          file={file}
          stats={diffStats?.[file.path]}
          onViewDiff={() => group.onViewDiff(file.path)}
          rowPaddingClassName={ROW_PADDING_CLASSNAME}
          indentPx={row.depth * TREE_INDENT_PX}
        />
      );
    },
    [diffStats, renderDirectory, renderHeader, visibleGroups]
  );

  // A divider is drawn above a file/directory row only when the row directly above
  // it belongs to the same group (so headers never get a spurious top border).
  const showDivider = React.useCallback(
    (index: number): boolean => {
      const row = rows[index];
      const previous = rows[index - 1];
      if (!row || !previous) return false;
      if (row.type !== 'file' && row.type !== 'directory') return false;
      if (previous.type !== 'file' && previous.type !== 'directory') return false;
      return previous.groupIndex === row.groupIndex;
    },
    [rows]
  );

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        <ScrollShadow
          ref={scrollRef}
          className="overlay-scrollbar-target overlay-scrollbar-container min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto"
        >
          {shouldVirtualize ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {/* Absolutely positioned rows: variable-height rows can drift from
                  the computed total height under flow stacking until measured. */}
              {virtualRows.map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    data-index={item.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                    className={cn(
                      showDivider(item.index) &&
                        'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                    )}
                  >
                    {renderRow(row, item.index === 0)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div role="list" aria-label={t('gitView.changes.changedFilesAria')}>
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    'relative',
                    showDivider(index) &&
                      'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                  )}
                >
                  {renderRow(row, index === 0)}
                </div>
              ))}
            </div>
          )}
        </ScrollShadow>
        <OverlayScrollbar containerRef={scrollRef} disableHorizontal />
    </div>
  );
};
