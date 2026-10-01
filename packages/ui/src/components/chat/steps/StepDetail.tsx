import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isStepDone, stepCopyTarget, type InboxStep } from '@/lib/inboxSteps';
import { safeLink, useInboxStore } from '@/lib/smartyInbox';
import type { StepActions } from './useStepActions';

type Props = { step: InboxStep; complete: boolean; actions: StepActions; compact?: boolean; mobile?: boolean };
export function StepDetail({ step, complete, actions, compact, mobile }: Props) {
  const { t } = useI18n();
  const guardedReopen = useInboxStore(s => s.guardedReopen);
  const { item, ordinal } = step;
  const done = isStepDone(item), status = actions.statuses.get(item.id);
  const [copyReceipt, setCopyReceipt] = React.useState<{ id: string; version: string; result: 'copied' | 'failed' } | null>(null);
  const copyStatus = copyReceipt?.id === item.id && copyReceipt.version === item.updated ? copyReceipt.result : null;
  const target = stepCopyTarget(item.recommendation ?? '');
  const copy = async () => {
    if (!target.safe) return;
    setCopyReceipt(null);
    const receipt = { id: item.id, version: item.updated };
    try {
      const result = await copyTextToClipboard(target.text);
      setCopyReceipt({ ...receipt, result: result.ok ? 'copied' : 'failed' });
    } catch { setCopyReceipt({ ...receipt, result: 'failed' }); }
  };
  const disabled = !complete || status?.state === 'pending' || status?.state === 'uncertain';
  const size = mobile ? 'lg' : 'sm';
  const controls = <>
    <Button variant="ghost" size={size} disabled={!complete || !target.safe || !target.text}
      aria-label={t('steps.copyLine', { step: ordinal, line: 1 })} onClick={() => void copy()}>{t('steps.copy')}</Button>
    {status?.state === 'uncertain' ? <Button size={size} variant="outline" onClick={() => void actions.check(item)}>{t('steps.checkStatus')}</Button>
      : (!done || guardedReopen) && <Button size={size} variant="outline" disabled={disabled || Boolean(item.resolved && !done)}
        aria-label={t(done ? 'steps.undoStep' : 'steps.doneStep', { step: ordinal })} aria-pressed={done}
        onClick={() => void actions.change(item, done)}>{status?.state === 'pending' ? t('steps.saving') : t(done ? 'steps.undo' : 'steps.done')}</Button>}
  </>;
  const feedback = status?.state === 'refused' ? status.error || t('common.unavailable')
    : status?.state === 'uncertain' ? t('steps.uncertain') : !target.safe ? t('steps.controlsRejected')
    : copyStatus ? t(copyStatus === 'copied' ? 'steps.copied' : 'steps.copyFailed')
    : item.resolved && !done ? t('steps.otherResolution') : '';
  return <div data-step-id={item.id} className={done ? 'text-muted-foreground' : 'text-foreground'}>
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className={compact ? 'truncate typography-ui-label' : 'typography-ui-label'}>
          {done && <span aria-label={t('steps.done')}>✓ </span>}{ordinal}. {item.title.slice(item.title.indexOf(' — ') + 3)}
        </p>
        <code className={compact ? 'block truncate whitespace-pre select-text' : 'block whitespace-pre-wrap break-all select-text'}>{target.text}</code>
      </div>
      {controls}
    </div>
    <p role={status || copyStatus === 'failed' || !target.safe ? 'alert' : 'status'}
      className={compact ? 'h-4 truncate typography-micro' : 'typography-micro'}>{feedback}</p>
    {!compact && <>
      {item.why && <p className="typography-ui-label text-muted-foreground whitespace-pre-wrap">{item.why}</p>}
      {item.links.map((link, index) => {
        const url = safeLink(link.url);
        return url ? <Button key={index} variant="link" size={size} asChild><a href={url} target="_blank" rel="noopener noreferrer"
          aria-label={t('steps.openLink', { link: link.label || url })}>{t('steps.open')} {link.label || url}</a></Button>
          : <span key={index} className="typography-micro break-all">{link.label || link.url}</span>;
      })}
    </>}
  </div>;
}
