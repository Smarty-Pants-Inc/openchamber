import React, { useCallback, useMemo } from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { GitStatus } from '@/lib/api/types';

type ChangeDescriptor = {
  code: string;
  color: string;
  description: string;
};

const CHANGE_DESCRIPTORS: Record<string, ChangeDescriptor> = {
  '?': { code: '?', color: 'var(--status-info)', description: 'Untracked file' },
  A: { code: 'A', color: 'var(--status-success)', description: 'New file' },
  D: { code: 'D', color: 'var(--status-error)', description: 'Deleted file' },
  R: { code: 'R', color: 'var(--status-info)', description: 'Renamed file' },
  C: { code: 'C', color: 'var(--status-info)', description: 'Copied file' },
  M: { code: 'M', color: 'var(--status-warning)', description: 'Modified file' },
};

const DEFAULT_DESCRIPTOR = CHANGE_DESCRIPTORS.M;

function getChangeSymbol(file: GitStatus['files'][number]): string {
  const indexCode = file.index?.trim();
  const workingCode = file.working_dir?.trim();

  if (indexCode && indexCode !== '?') return indexCode.charAt(0);
  if (workingCode) return workingCode.charAt(0);

  return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
}

function describeChange(file: GitStatus['files'][number]): ChangeDescriptor {
  const symbol = getChangeSymbol(file);
  return CHANGE_DESCRIPTORS[symbol] ?? DEFAULT_DESCRIPTOR;
}

interface ChangeRowProps {
  file: GitStatus['files'][number];
  onViewDiff: () => void;
  stats?: { insertions: number; deletions: number };
  rowPaddingClassName?: string;
  indentPx?: number;
}

export const ChangeRow = React.memo<ChangeRowProps>(function ChangeRow({
  file,
  onViewDiff,
  stats,
  rowPaddingClassName,
  indentPx = 0,
}) {
  const descriptor = useMemo(() => describeChange(file), [file]);
  const indicatorLabel = descriptor.description;
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onViewDiff();
      }
    },
    [onViewDiff]
  );

  return (
    <div
      className={`group flex items-center gap-2 py-1.5 cursor-pointer ${rowPaddingClassName ?? 'px-3'}`}
      role="button"
      tabIndex={0}
      onClick={onViewDiff}
      onKeyDown={handleKeyDown}
      style={indentPx > 0 ? { paddingLeft: `${indentPx}px` } : undefined}
    >
        <span
          className="typography-micro font-semibold w-4 text-center uppercase"
          style={{ color: descriptor.color }}
          title={indicatorLabel}
          aria-label={indicatorLabel}
        >
          {descriptor.code}
        </span>
        <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 shrink-0" />
        {(() => {
          const lastSlash = file.path.lastIndexOf('/');
          if (lastSlash === -1) {
            return (
              <span
                className="flex-1 min-w-0 truncate typography-ui-label text-foreground"
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={file.path}
              >
                {file.path}
              </span>
            );
          }
          const dir = file.path.slice(0, lastSlash);
          const name = file.path.slice(lastSlash);
          return (
            <span className="flex-1 min-w-0 flex items-baseline overflow-hidden" title={file.path}>
              <span
                className="min-w-0 truncate typography-ui-label text-muted-foreground"
                  style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
              >
                {dir}
              </span>
              <span className="flex-shrink-0 typography-ui-label"><span className="text-muted-foreground">/</span><span className="text-foreground">{name.slice(1)}</span></span>
            </span>
          );
        })()}
        <span className="shrink-0 typography-micro">
          <span style={{ color: 'var(--status-success)' }}>+{insertions}</span>
          <span className="text-muted-foreground mx-0.5">/</span>
          <span style={{ color: 'var(--status-error)' }}>-{deletions}</span>
        </span>
    </div>
  );
});
