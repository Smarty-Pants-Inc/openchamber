import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getCommitFileDiff, type CommitFileDiffResponse } from '@/lib/gitApi';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import type { LanedCommit } from './gitGraph';
import { GitGraphSegment } from './GitGraphSegment';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

const HISTORY_DIFF_REQUEST_TIMEOUT_MS = 15000;
const HISTORY_DIFF_LARGE_CHANGED_LINES = 500;
const HISTORY_DIFF_CACHE_MAX_ENTRIES = 12;
const HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES = 8 * 1024 * 1024;

type HistoryDiffCacheValue = CommitFileDiffResponse | 'loading' | 'error';

const getHistoryDiffCacheSize = (value: HistoryDiffCacheValue): number => {
  if (typeof value === 'string') {
    return 0;
  }
  return (value.original?.length ?? 0) + (value.modified?.length ?? 0);
};

const trimHistoryDiffCache = (cache: Map<string, HistoryDiffCacheValue>): Map<string, HistoryDiffCacheValue> => {
  if (cache.size <= HISTORY_DIFF_CACHE_MAX_ENTRIES) {
    let totalSize = 0;
    for (const value of cache.values()) {
      totalSize += getHistoryDiffCacheSize(value);
    }
    if (totalSize <= HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES) {
      return cache;
    }
  }

  const entries = Array.from(cache.entries()).reverse();
  const next = new Map<string, HistoryDiffCacheValue>();
  let totalSize = 0;
  for (const [key, value] of entries) {
    if (next.size >= HISTORY_DIFF_CACHE_MAX_ENTRIES) {
      continue;
    }
    const entrySize = getHistoryDiffCacheSize(value);
    if (totalSize + entrySize > HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES && next.size > 0) {
      continue;
    }
    next.set(key, value);
    totalSize += entrySize;
  }

  return new Map(Array.from(next.entries()).reverse());
};

interface HistoryCommitRowProps {
  entry: GitLogEntry;
  mode?: 'history' | 'graph';
  laned?: LanedCommit;
  totalLanes?: number;
  isExpanded: boolean;
  onToggle: () => void;
  files: CommitFileEntry[];
  isLoadingFiles: boolean;
  onCopyHash: (hash: string) => void;
  directory: string | undefined;
}

function formatCommitDate(date: string, timeFormatPreference: TimeFormatPreference) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) {
    return date;
  }

  return formatDateTimeForPreference(value, timeFormatPreference, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getChangeTypeColor(changeType: string) {
  switch (changeType) {
    case 'A':
      return 'text-[var(--status-success)]';
    case 'D':
      return 'text-[var(--status-error)]';
    case 'M':
      return 'text-[var(--status-warning)]';
    case 'R':
      return 'text-[var(--status-info)]';
    default:
      return 'text-muted-foreground';
  }
}

interface RefBadge {
  label: string;
  isHead: boolean;
  isTag: boolean;
}

function parseRefBadges(refs: string): RefBadge[] {
  if (!refs) return [];
  return refs
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const isHead = r.startsWith('HEAD ->');
      const label = isHead ? r.replace('HEAD -> ', '') : r.replace('tag: ', '');
      return {
        label,
        isHead,
        isTag: r.startsWith('tag: '),
      };
    });
}

export const HistoryCommitRow = React.memo(({
  entry,
  mode = 'history',
  laned,
  totalLanes,
  isExpanded,
  onToggle,
  files,
  isLoadingFiles,
  onCopyHash,
  directory,
}: HistoryCommitRowProps) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const isGraphMode = mode === 'graph';
  const [openDiffPaths, setOpenDiffPaths] = React.useState<Set<string>>(new Set());
  const [diffCache, setDiffCache] = React.useState<Map<string, HistoryDiffCacheValue>>(new Map());
  const [forceRenderLargePaths, setForceRenderLargePaths] = React.useState<Set<string>>(new Set());

  const loadFileDiff = React.useCallback(async (file: CommitFileEntry) => {
    const key = file.path;
    if (!directory) {
      setDiffCache(prev => new Map(prev).set(key, 'error'));
      return;
    }

    setDiffCache(prev => trimHistoryDiffCache(new Map(prev).set(key, 'loading')));
    try {
      const fetchPromise = getCommitFileDiff(directory, entry.hash, file.path, false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out after ${HISTORY_DIFF_REQUEST_TIMEOUT_MS}ms`)), HISTORY_DIFF_REQUEST_TIMEOUT_MS);
      });
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      setDiffCache(prev => trimHistoryDiffCache(new Map(prev).set(key, result)));
    } catch {
      setDiffCache(prev => new Map(prev).set(key, 'error'));
    }
  }, [directory, entry.hash]);

  const toggleFileDiff = React.useCallback(async (file: CommitFileEntry) => {
    const key = file.path;

    if (file.changeType === 'R' || file.isBinary) {
      setOpenDiffPaths(prev => {
        const next = new Set(prev);
        if (next.has(key)) { next.delete(key); } else { next.add(key); }
        return next;
      });
      return;
    }

    const cached = diffCache.get(key);
    const isOpen = openDiffPaths.has(key);

    if (isOpen && cached && cached !== 'error') {
      // Close it
      setOpenDiffPaths(prev => { const next = new Set(prev); next.delete(key); return next; });
      return;
    }

    // Open it (or re-fetch on error)
    setOpenDiffPaths(prev => { const next = new Set(prev); next.add(key); return next; });

    if (cached && cached !== 'error') return; // Already loaded

    const changedLines = file.insertions + file.deletions;
    if (changedLines > HISTORY_DIFF_LARGE_CHANGED_LINES && !forceRenderLargePaths.has(key)) {
      return;
    }

    await loadFileDiff(file);
  }, [diffCache, forceRenderLargePaths, loadFileDiff, openDiffPaths]);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
          isGraphMode
            ? 'hover:bg-[var(--interactive-hover)]/40'
            : isExpanded ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
        )}
      >
        {isGraphMode && laned && totalLanes !== undefined ? (
          <div className="-my-2 shrink-0 self-stretch">
            <GitGraphSegment laned={laned} totalLanes={totalLanes} isExpanded={isExpanded} />
          </div>
        ) : (
          <div
            className="h-2 w-2 translate-y-2 rounded-full shrink-0"
            style={{ backgroundColor: 'var(--status-success)' }}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          {/* Ref badges */}
          {isGraphMode ? (() => {
            const badges = parseRefBadges(entry.refs);
            return badges.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-0.5">
                {badges.map((badge) => (
                  <span key={badge.label}
                    className={cn(
                      'inline-flex items-center px-1.5 py-0 typography-micro rounded font-medium',
                      badge.isHead
                        ? 'bg-[var(--chart-1)] text-[var(--primary-foreground)]'
                        : badge.isTag
                        ? 'bg-[var(--chart-5)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--interactive-hover)] text-[var(--foreground)]'
                    )}>
                    {badge.label}
                  </span>
                ))}
              </div>
            ) : null;
          })() : null}

          <p className="typography-ui-label font-medium text-foreground line-clamp-1">
            {entry.message}
          </p>
          <div className="flex items-center gap-1 typography-meta text-muted-foreground">
            <div className="flex items-center gap-1 min-w-0 truncate">
              <span className="truncate min-w-[3ch]" title={entry.author_name}>
                {entry.author_name}
              </span>
              <span className="shrink-0">·</span>
              <span className="truncate min-w-0" title={formatCommitDate(entry.date, timeFormatPreference)}>
                {formatCommitDate(entry.date, timeFormatPreference)}
              </span>
            </div>
            <span className="shrink-0">·</span>
            <code className="shrink-0 font-mono">
              {entry.hash.slice(0, 8)}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyHash(entry.hash);
                  }}
                >
                  <Icon name="file-copy" className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>{t('gitView.history.copySha')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 pl-8 border-t border-border/40">
          {isLoadingFiles ? (
            <div className="flex items-center gap-2 py-2">
              <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
              <span className="typography-micro text-muted-foreground">{t('gitView.history.loadingFiles')}</span>
            </div>
          ) : files.length === 0 ? (
            <p className="typography-micro text-muted-foreground py-2">{t('gitView.history.noFiles')}</p>
          ) : (
            <ul className="space-y-0.5 py-2">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => toggleFileDiff(file)}
                    className={cn(
                      'w-full flex items-center gap-2 typography-micro text-left cursor-pointer transition-colors rounded px-1',
                      openDiffPaths.has(file.path) ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
                    )}
                  >
                    <span
                      className={cn(
                        'font-semibold w-3 text-center shrink-0',
                        getChangeTypeColor(file.changeType)
                      )}
                    >
                      {file.changeType}
                    </span>
                    <span className="truncate text-foreground min-w-0" title={file.path}>
                      {file.path}
                    </span>
                    {!file.isBinary && (
                      <span className="shrink-0">
                        <span style={{ color: 'var(--status-success)' }}>
                          +{file.insertions}
                        </span>
                        <span className="text-muted-foreground mx-0.5">/</span>
                        <span style={{ color: 'var(--status-error)' }}>
                          -{file.deletions}
                        </span>
                      </span>
                    )}
                    {file.isBinary && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        {t('gitView.history.binary')}
                      </span>
                    )}
                    <Icon
                      name={openDiffPaths.has(file.path) ? 'arrow-down-s' : 'arrow-right-s'}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                  </button>

                  {openDiffPaths.has(file.path) && (
                    <div className="max-h-[400px] overflow-y-auto rounded border border-border/40 mx-2 mb-1" data-diff-virtual-root data-diff-virtual-content>
                      {file.changeType === 'R' ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.renamedNoDiff')}</div>
                      ) : file.isBinary ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.binaryNoDiff')}</div>
                      ) : (() => {
                        const changedLines = file.insertions + file.deletions;
                        if (!forceRenderLargePaths.has(file.path) && changedLines > HISTORY_DIFF_LARGE_CHANGED_LINES) {
                          return (
                            <div className="flex flex-col items-start gap-1 px-3 py-2 text-sm text-muted-foreground">
                              <div className="typography-ui-label font-semibold text-foreground">
                                {t('gitView.history.largeDiffTitle', { count: changedLines })}
                              </div>
                              <div className="typography-meta text-muted-foreground">
                                {t('gitView.history.largeDiffDescription')}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="h-6 px-0 text-primary hover:bg-transparent hover:underline"
                                onClick={() => {
                                  setForceRenderLargePaths(prev => new Set(prev).add(file.path));
                                  void loadFileDiff(file);
                                }}
                              >
                                {t('gitView.history.renderDiffAnyway')}
                              </Button>
                            </div>
                          );
                        }

                        const cached = diffCache.get(file.path);
                        if (cached === 'loading' || cached === undefined) {
                          return <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.loadingDiff')}</div>;
                        }
                        if (cached === 'error') {
                          return (
                            <button
                              type="button"
                              onClick={() => toggleFileDiff(file)}
                              className="w-full text-left px-3 py-2 text-sm text-muted-foreground hover:bg-[var(--interactive-hover)] transition-colors"
                            >
                              {t('gitView.history.diffError')}
                            </button>
                          );
                        }
                        return (
                            <PierreDiffViewer
                             original={cached.original}
                             modified={cached.modified}
                             language={getLanguageFromExtension(file.path) || ''}
                              fileName={file.path}
                              renderSideBySide={false}
                              layout="inline"
                              enableComments={false}
                            />
                        );
                      })()}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
});
