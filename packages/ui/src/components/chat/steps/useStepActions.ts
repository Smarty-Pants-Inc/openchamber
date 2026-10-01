import React from 'react';
import { changeInboxStep } from '@/lib/inboxStepActions';
import { loadInboxItem, refreshInboxBadge, useInboxStore, type InboxItem } from '@/lib/smartyInbox';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from '@/lib/runtime-switch';

type ActionStatus = { state: 'pending' } | { state: 'refused'; error?: string } | { state: 'uncertain' };
export function useStepActions() {
  const busy = React.useRef(new Map<string, RuntimeRequestScope>());
  const [statuses, setStatuses] = React.useState(new Map<string, ActionStatus>());
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    busy.current.clear(); setStatuses(new Map());
  }), []);
  const setStatus = (id: string, status?: ActionStatus) => setStatuses(old => {
    const next = new Map(old);
    if (status) next.set(id, status); else next.delete(id);
    return next;
  });
  const change = async (item: InboxItem, undo: boolean) => {
    if (busy.current.has(item.id) || statuses.get(item.id)?.state === 'uncertain' || (undo && !useInboxStore.getState().guardedReopen)) return;
    const scope = captureRuntimeRequestScope();
    busy.current.set(item.id, scope);
    setStatus(item.id, { state: 'pending' });
    try {
      const result = await changeInboxStep(item, undo);
      if (!isRuntimeRequestScopeCurrent(scope)) return;
      if (result.state === 'refused') { setStatus(item.id, result); void refreshInboxBadge(); return; }
      if (result.item) useInboxStore.getState().recordItem(result.item);
      setStatus(item.id, result.state === 'uncertain' ? { state: 'uncertain' } : undefined);
      void refreshInboxBadge();
    } finally { if (busy.current.get(item.id) === scope) busy.current.delete(item.id); }
  };
  const check = async (item: InboxItem) => {
    if (busy.current.has(item.id)) return;
    const scope = captureRuntimeRequestScope();
    busy.current.set(item.id, scope);
    setStatus(item.id, { state: 'pending' });
    try {
      const current = await loadInboxItem(item.id);
      if (!isRuntimeRequestScopeCurrent(scope)) return;
      if (current.id !== item.id || current.to !== item.to) { setStatus(item.id, { state: 'uncertain' }); return; }
      useInboxStore.getState().recordItem(current);
      setStatus(item.id);
    } catch { if (isRuntimeRequestScopeCurrent(scope)) setStatus(item.id, { state: 'uncertain' }); }
    finally { if (busy.current.get(item.id) === scope) busy.current.delete(item.id); }
  };
  return { statuses, change, check };
}
export type StepActions = ReturnType<typeof useStepActions>;
