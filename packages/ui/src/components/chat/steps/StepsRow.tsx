import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import { isStepDone, selectStepList, type InboxStepList } from '@/lib/inboxSteps';
import { useInboxStore } from '@/lib/smartyInbox';
import { isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { StepDetail } from './StepDetail';
import type { StepsSheetDismiss } from './useStepsSheetBack';
import { useStepActions } from './useStepActions';

type Props = { lists: InboxStepList[]; mobile?: boolean; scope: RuntimeRequestScope | null; sheet?: StepsSheetDismiss };
export function StepsRow({ lists, mobile, scope, sheet }: Props) {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const actions = useStepActions(scope);
  const snapshotValid = useInboxStore(s => s.snapshotValid);
  const guardedReopen = useInboxStore(s => s.guardedReopen);
  const list = scope && isRuntimeRequestScopeCurrent(scope) ? selectStepList(lists, selected) : undefined;
  const shown = Boolean(list);
  // The open phone sheet is the top-most layer for the shell's native Back; a remount, close or hidden row unregisters it.
  React.useEffect(() => {
    if (!mobile || !open || !sheet || !shown) return;
    const close = () => setOpen(false);
    sheet.current = close;
    return () => { if (sheet.current === close) sheet.current = null; };
  }, [mobile, open, sheet, shown]);
  // Keep the first selection even if the gateway's priority/newest ordering changes. A hidden row closes its overlay.
  React.useEffect(() => { if (!list) setOpen(false); else if (list.key !== selected) setSelected(list.key); }, [list, selected]);
  if (!list) return null;
  const completed = list.steps.filter(step => isStepDone(step.item)).length;
  const next = list.steps.find(step => !step.item.resolved) ?? list.steps.find(step => !isStepDone(step.item)) ?? list.steps.at(-1);
  const progress = !snapshotValid ? t('common.unavailable') : list.complete ? t('steps.progress', { done: completed, total: list.total })
    : t('steps.receiving', { received: list.steps.length, total: list.total });
  const content = <div className="space-y-3">
    <label className="flex items-center gap-2 typography-ui-label">
      {t('steps.list')}
      <select aria-label={t('steps.list')} className={dropdownTriggerVariants({ size: 'default' })}
        value={list.key} onChange={e => setSelected(e.target.value)}>
        {lists.map(option => <option key={option.key} value={option.key}>{option.topic}</option>)}
      </select>
    </label>
    <p className="typography-ui-label text-muted-foreground">{progress}</p>
    <ol className="space-y-4">
      {list.steps.map(step => <li key={step.item.id}><StepDetail step={step} complete={list.complete && snapshotValid} actions={actions} mobile={mobile} /></li>)}
    </ol>
  </div>;
  const trigger = <Button variant="outline" size={mobile ? 'lg' : 'sm'}
    aria-label={t('steps.all')}>{t('steps.all')} ▾</Button>;
  return <section aria-label={t('steps.title')} data-steps-row="true" className={`shrink-0 border-b border-border bg-[var(--surface-elevated)] px-3 py-2 ${mobile ? 'h-40' : 'h-32'}`}>
    <div className="flex min-w-0 items-center gap-2">
      <strong className="typography-ui-label">{t('steps.title')}</strong>
      <span className="min-w-0 flex-1 truncate typography-ui-label" title={list.topic}>{list.topic}</span>
      <span role="status" className="min-w-0 max-w-[35%] truncate typography-micro text-muted-foreground" title={progress}>{progress}</span>
      {mobile ? <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent showCloseButton={false} className="fixed inset-x-0 bottom-0 mx-auto max-h-[75dvh] rounded-b-none pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between"><DialogTitle>{t('steps.title')}</DialogTitle>
            <Button size="lg" variant="ghost" onClick={() => setOpen(false)}>{t('dialog.common.actions.close')}</Button>
          </div>{content}
        </DialogContent>
      </Dialog> : <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={trigger} />
        <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup aria-label={t('steps.all')} className="max-h-[min(70dvh,36rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-foreground">
            {content}
          </Popover.Popup>
        </Popover.Positioner></Popover.Portal>
      </Popover.Root>}
    </div>
    {list.complete && next && <StepDetail step={next} complete={snapshotValid} actions={actions} compact mobile={mobile} />}
    {!guardedReopen && <p className="typography-micro text-muted-foreground">{t('steps.undoUnavailable')}</p>}
  </section>;
}
