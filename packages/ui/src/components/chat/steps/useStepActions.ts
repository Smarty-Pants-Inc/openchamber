import React from 'react';
import { actOnInboxStep, changeInboxStep, type StepActionResult } from '@/lib/inboxStepActions';
import { loadInboxItem, refreshInboxBadge, useInboxStore, type InboxItem } from '@/lib/smartyInbox';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';

type ActionStatus = { state: 'pending' } | { state: 'refused'; error?: string } | { state: 'uncertain' };
export function useStepActions(displayedScope: RuntimeRequestScope | null = captureRuntimeRequestScope()) {
  const busy = React.useRef(new Map<string, RuntimeRequestScope>());
  const statusRef = React.useRef(new Map<string, ActionStatus>());
  const [statuses, setStatuses] = React.useState(statusRef.current);
  React.useEffect(() => {
    const reset = () => { busy.current.clear(); statusRef.current = new Map(); setStatuses(statusRef.current); };
    const unsubscribe = subscribeRuntimeEndpointChanged(reset);
    const unsubscribeAuth = useAuthSessionStore.subscribe((state, before) => {
      if (state.recoveryGeneration !== before.recoveryGeneration) reset();
    });
    return () => { unsubscribe(); unsubscribeAuth(); };
  }, []);
  const setStatus = (id: string, status?: ActionStatus) => {
    const next = new Map(statusRef.current);
    if (status) next.set(id, status); else next.delete(id);
    statusRef.current = next;
    setStatuses(next);
  };
  const isCurrent = () => displayedScope !== null && isRuntimeRequestScopeCurrent(displayedScope);
  const run = async (item: InboxItem, write: () => Promise<StepActionResult>) => {
    if (!isCurrent() || busy.current.has(item.id) || statusRef.current.get(item.id)?.state === 'uncertain') return;
    const scope = captureRuntimeRequestScope();
    busy.current.set(item.id, scope);
    setStatus(item.id, { state: 'pending' });
    try {
      const result = await write();
      if (!isRuntimeRequestScopeCurrent(scope)) return;
      if (result.state === 'refused') { setStatus(item.id, result); void refreshInboxBadge(); return result; }
      if (result.item) useInboxStore.getState().recordItem(result.item, scope);
      setStatus(item.id, result.state === 'uncertain' ? { state: 'uncertain' } : undefined);
      void refreshInboxBadge();
      return result;
    } finally { if (busy.current.get(item.id) === scope) busy.current.delete(item.id); }
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
    if (!isCurrent() || busy.current.has(item.id)) return;
    const scope = captureRuntimeRequestScope();
    busy.current.set(item.id, scope);
    setStatus(item.id, { state: 'pending' });
    try {
      const current = await loadInboxItem(item.id);
      if (!isRuntimeRequestScopeCurrent(scope)) return;
      if (current.id !== item.id || current.to !== item.to) { setStatus(item.id, { state: 'uncertain' }); return; }
      useInboxStore.getState().recordItem(current, scope);
      useInboxStore.getState().invalidateSnapshot();
      setStatus(item.id);
      void refreshInboxBadge({ reusePending: true });
    } catch { if (isRuntimeRequestScopeCurrent(scope)) setStatus(item.id, { state: 'uncertain' }); }
    finally { if (busy.current.get(item.id) === scope) busy.current.delete(item.id); }
  };
  return { statuses, change, act, check, isCurrent };
}
export type StepActions = ReturnType<typeof useStepActions>;
