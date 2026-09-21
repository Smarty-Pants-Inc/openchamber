import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { formatEffortLabel } from './mobileControlsUtils';

/** Native selectors own mutations; this is the selected session's live state. */
export function OrdinaryModelControls({ state, className }: { state: OrdinaryModelState; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn('flex min-w-0 items-center gap-2 typography-meta text-muted-foreground', className)} aria-live="polite">
      {state.model ? <>
        <span className="truncate" title={state.model.providerID}>{state.model.providerID}</span>
        <span className="model-controls__model-label min-w-0 truncate" title={state.model.modelID}>{state.model.name}</span>
        <span className="model-controls__variant-label whitespace-nowrap">{formatEffortLabel(state.thinkingLevel ?? undefined)}</span>
      </> : <span>{t('common.unavailable')}</span>}
    </div>
  );
}
