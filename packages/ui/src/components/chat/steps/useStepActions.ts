import { actOnInboxStep, changeInboxStep, claimStepAction, releaseStepAction, settleStepAction, stepActionStatus,
  useStepActionStatusStore, type StepActionResult } from '@/lib/inboxStepActions';
import { loadInboxItem, refreshInboxBadge, useInboxStore, type InboxItem } from '@/lib/smartyInbox';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';

/** Steps write actions for the row and the Inbox. Their pending/uncertain lock lives in the shared status store. */
export function useStepActions(displayedScope: RuntimeRequestScope | null = captureRuntimeRequestScope()) {
  const entries = useStepActionStatusStore(s => s.entries);
  const status = (item: InboxItem) => stepActionStatus(entries, item);
  const isCurrent = () => displayedScope !== null && isRuntimeRequestScopeCurrent(displayedScope);
  const run = async (item: InboxItem, write: () => Promise<StepActionResult>) => {
    if (!isCurrent()) return;
    const claim = claimStepAction(item, false);
    if (!claim) return;
    try {
      const result = await write();
      if (!isRuntimeRequestScopeCurrent(claim.scope)) return;
      if (result.state === 'refused') { settleStepAction(claim, result); void refreshInboxBadge(); return result; }
      if (result.item) useInboxStore.getState().recordItem(result.item, claim.scope);
      settleStepAction(claim, result.state === 'uncertain' ? { state: 'uncertain' } : undefined);
      void refreshInboxBadge();
      return result;
    } finally { releaseStepAction(claim); }
  };
  const change = (item: InboxItem, undo: boolean) => {
    if (undo && !useInboxStore.getState().guardedReopen) return;
    return run(item, () => changeInboxStep(item, undo));
  };
  const act = (item: InboxItem, action: 'answer' | 'reopen', body: Record<string, string>) => {
    if (action === 'reopen' && !useInboxStore.getState().guardedReopen) return;
    return run(item, () => actOnInboxStep(item, action, body));
  };
  const check = async (item: InboxItem) => {
    if (!isCurrent()) return;
    const claim = claimStepAction(item, true);
    if (!claim) return;
    try {
      const current = await loadInboxItem(item.id);
      if (!isRuntimeRequestScopeCurrent(claim.scope)) return;
      if (current.id !== item.id || current.to !== item.to) { settleStepAction(claim, { state: 'uncertain' }); return; }
      useInboxStore.getState().recordItem(current, claim.scope);
      useInboxStore.getState().invalidateSnapshot();
      settleStepAction(claim);
      void refreshInboxBadge({ reusePending: true });
    } catch { settleStepAction(claim, { state: 'uncertain' }); }
    finally { releaseStepAction(claim); }
  };
  return { status, change, act, check, isCurrent };
}
export type StepActions = ReturnType<typeof useStepActions>;
