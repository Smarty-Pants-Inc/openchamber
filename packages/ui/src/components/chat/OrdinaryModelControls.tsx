import React from 'react';
import { toast } from '@/components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { modelVariantNames } from '@/lib/modelVariants';
import { opencodeClient } from '@/lib/opencode/client';
import type { OrdinaryModelChange, OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { getImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { formatEffortLabel } from './mobileControlsUtils';

export type OrdinaryModelTarget = { sessionId: string; directory: string };
type Option = { key: string; providerID: string; modelID: string; name: string; levels: string[] };

const optionKey = (providerID: string, modelID: string) => JSON.stringify([providerID, modelID]);

/**
 * The selected native session's live model/effort. With a target, each choice asks the
 * native session to switch; the display changes only when the session reports it.
 */
export function OrdinaryModelControls({ state, target, className }: {
  state: OrdinaryModelState; target?: OrdinaryModelTarget; className?: string;
}) {
  const { t } = useI18n();
  // A chat column may show a session from a project that is not the active one.
  const providers = useConfigStore(s => selectProvidersForDirectory(s, target?.directory));
  const loadProviders = useConfigStore(s => s.loadProviders);
  const [busy, setBusy] = React.useState(false);
  const options = React.useMemo<Option[]>(() => providers.flatMap(provider => provider.models.map(model => ({
    key: optionKey(provider.id, model.id), providerID: provider.id, modelID: model.id,
    name: model.name || model.id, levels: modelVariantNames(model),
  }))), [providers]);
  const current = state.model;
  const selected = current ? options.find(option => option.key === optionKey(current.providerID, current.modelID)) : undefined;
  const directory = target?.directory;
  const missing = Boolean(current && !selected);
  // The project catalog may have been read before any native session was live. Re-read it once.
  React.useEffect(() => {
    if (directory && missing) void loadProviders({ directory, source: 'ordinaryModelControls' });
  }, [directory, missing, loadProviders]);

  if (!current) {
    return <div className={cn('flex min-w-0 items-center gap-2 typography-meta text-muted-foreground', className)}
      aria-live="polite"><span>{t('common.unavailable')}</span></div>;
  }
  const effortLabel = formatEffortLabel(state.thinkingLevel ?? undefined);
  const apply = async (change: Omit<OrdinaryModelChange, 'generation'>) => {
    if (!target || !state.generation || busy) return;
    setBusy(true);
    try {
      await opencodeClient.setOrdinaryModel(target.sessionId, target.directory, { generation: state.generation, ...change });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.unavailable'));
      setBusy(false);
      return;
    }
    // The switch is applied; the display follows the session's own report. The native journal gained
    // model/effort entries, so re-read the accepted history view. The loader keeps its own failure state.
    await getImperativeSessionMessageLoader()?.refreshOrdinaryView({ directory: target.directory, sessionID: target.sessionId })
      .catch(() => undefined);
    setBusy(false);
  };

  return (
    <div className={cn('flex min-w-0 items-center gap-2 typography-meta text-muted-foreground', className)} aria-live="polite">
      {target && selected ? (
        <Select value={selected.key} disabled={busy} onValueChange={value => {
          const next = options.find(option => option.key === value);
          if (next && next.key !== selected.key) void apply({ model: { providerID: next.providerID, modelID: next.modelID } });
        }}>
          <SelectTrigger size="sm" className="min-w-0 gap-1.5 px-2 py-1" aria-label={t('chat.modelControls.model')}>
            <span className="truncate" title={current.providerID}>{current.providerID}</span>
            <span className="model-controls__model-label min-w-0 truncate" title={current.modelID}>{current.name}</span>
          </SelectTrigger>
          <SelectContent align="end">
            {options.map(option => (
              <SelectItem key={option.key} value={option.key}>
                <span className="truncate">{option.providerID} / {option.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : <>
        <span className="truncate" title={current.providerID}>{current.providerID}</span>
        <span className="model-controls__model-label min-w-0 truncate" title={current.modelID}>{current.name}</span>
      </>}
      {target && selected && state.thinkingLevel && selected.levels.length > 1 ? (
        <Select value={state.thinkingLevel} disabled={busy} onValueChange={value => {
          if (value && value !== state.thinkingLevel) {
            void apply({ model: { providerID: current.providerID, modelID: current.modelID }, thinkingLevel: value });
          }
        }}>
          <SelectTrigger size="sm" className="gap-1.5 px-2 py-1" aria-label={t('chat.modelControls.thinking')}>
            <span className="model-controls__variant-label whitespace-nowrap">{effortLabel}</span>
          </SelectTrigger>
          <SelectContent align="end">
            {selected.levels.map(level => <SelectItem key={level} value={level}>{formatEffortLabel(level)}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : <span className="model-controls__variant-label whitespace-nowrap">{effortLabel}</span>}
    </div>
  );
}
