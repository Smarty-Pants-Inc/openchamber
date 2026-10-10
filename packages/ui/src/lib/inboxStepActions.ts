import { actOnInboxItem, inboxItemState, InboxRequestError, loadInboxItem, type InboxItem } from './smartyInbox';
import { isStepDone, STEP_DONE_REPORT } from './inboxSteps';
import { create } from 'zustand';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from './runtime-switch';
import { useAuthSessionStore } from './runtime-auth-expiry';

export type StepActionResult =
  | { state: 'stored'; item: InboxItem }
  | { state: 'refused'; error?: string }
  | { state: 'uncertain'; item?: InboxItem };
export type StepActionStatus = { state: 'pending' } | { state: 'refused'; error?: string } | { state: 'uncertain' };
type StepActionEntry = { scope: RuntimeRequestScope; status: StepActionStatus; claim: symbol };
export type StepActionClaim = { key: string; scope: RuntimeRequestScope; claim: symbol };

/**
 * Pending and uncertain Steps writes, shared by the Steps row and the Inbox so closing either entry point keeps the
 * lock. Keyed by runtime/auth scope, recipient and item; an entry from a retired scope is never read.
 */
export const useStepActionStatusStore = create<{ entries: ReadonlyMap<string, StepActionEntry> }>(() => ({ entries: new Map() }));
const stepActionKey = (scope: RuntimeRequestScope, item: Pick<InboxItem, 'id' | 'to'>) =>
  JSON.stringify([scope.runtimeKey, scope.transportGeneration, scope.authGeneration, item.to, item.id]);
const putStepActionEntry = (key: string, entry?: StepActionEntry) => useStepActionStatusStore.setState(({ entries }) => {
  const next = new Map(entries);
  if (entry) next.set(key, entry); else next.delete(key);
  return { entries: next };
});
export function clearStepActionStatuses() { useStepActionStatusStore.setState({ entries: new Map() }); }
subscribeRuntimeEndpointChanged(clearStepActionStatuses);
useAuthSessionStore.subscribe((state, before) => {
  if (state.recoveryGeneration !== before.recoveryGeneration) clearStepActionStatuses();
});

export function stepActionStatus(entries: ReadonlyMap<string, StepActionEntry>, item: Pick<InboxItem, 'id' | 'to'>) {
  const scope = captureRuntimeRequestScope();
  const entry = entries.get(stepActionKey(scope, item));
  return entry && isRuntimeRequestScopeCurrent(entry.scope) ? entry.status : undefined;
}
/** Marks the item pending. Refuses while it is pending, or uncertain unless this is the read-only Check status. */
export function claimStepAction(item: Pick<InboxItem, 'id' | 'to'>, checkOnly: boolean): StepActionClaim | null {
  const current = stepActionStatus(useStepActionStatusStore.getState().entries, item);
  if (current?.state === 'pending' || (!checkOnly && current?.state === 'uncertain')) return null;
  const scope = captureRuntimeRequestScope();
  const claim = { key: stepActionKey(scope, item), scope, claim: Symbol('step action') };
  putStepActionEntry(claim.key, { scope, status: { state: 'pending' }, claim: claim.claim });
  return claim;
}
/** Only the operation that owns the entry may settle it; a cleared or replaced entry stays as it is. */
export function settleStepAction(claim: StepActionClaim, status?: StepActionStatus) {
  if (useStepActionStatusStore.getState().entries.get(claim.key)?.claim !== claim.claim) return;
  putStepActionEntry(claim.key, status && isRuntimeRequestScopeCurrent(claim.scope) ? { scope: claim.scope, status, claim: claim.claim } : undefined);
}
export function releaseStepAction(claim: StepActionClaim) {
  const entry = useStepActionStatusStore.getState().entries.get(claim.key);
  if (entry?.claim === claim.claim && entry.status.state === 'pending') putStepActionEntry(claim.key);
}

type StepActionDependencies = {
  write: typeof actOnInboxItem;
  read: typeof loadInboxItem;
  operationKey: () => string | undefined;
};
const defaults: StepActionDependencies = {
  write: actOnInboxItem, read: loadInboxItem, operationKey: () => globalThis.crypto?.randomUUID?.(),
};

/** Preparation cannot have written anything. Missing UUID support uses the existing Unavailable feedback. */
function prepareInboxStepGuard(item: InboxItem, operationKey = defaults.operationKey) {
  try {
    const opKey = operationKey();
    return opKey ? { updated: item.updated, opKey } : null;
  } catch { return null; }
}

/** One conditional write shared by Steps and Inbox. Unknown responses permit only a read, never a replay. */
export async function actOnInboxStep(item: InboxItem, action: 'answer' | 'reopen', body: Record<string, string>,
  dependencies = defaults, confirmed: (stored: InboxItem) => boolean = () => true): Promise<StepActionResult> {
  const guard = prepareInboxStepGuard(item, dependencies.operationKey);
  if (!guard) return { state: 'refused' };
  const scope = captureRuntimeRequestScope();
  try {
    const stored = await dependencies.write(item.id, action, { ...body, ...guard });
    if (stored.id !== item.id || stored.to !== item.to || !confirmed(stored)) {
      throw new Error('Unconfirmed inbox acknowledgement');
    }
    return { state: 'stored', item: stored };
  } catch (error) {
    if (!isRuntimeRequestScopeCurrent(scope)) return { state: 'uncertain' };
    if (error instanceof InboxRequestError && !error.uncertain) return { state: 'refused', error: error.message };
    try {
      const current = await dependencies.read(item.id);
      return current.id === item.id && current.to === item.to ? { state: 'uncertain', item: current } : { state: 'uncertain' };
    } catch {
      return { state: 'uncertain' };
    }
  }
}

export async function changeInboxStep(item: InboxItem, undo: boolean, dependencies = defaults): Promise<StepActionResult> {
  if (undo ? !isStepDone(item) : inboxItemState(item) !== 'open' || item.actions.length !== 1 || item.actions[0] !== 'respond') {
    return { state: 'refused' };
  }
  return actOnInboxStep(item, undo ? 'reopen' : 'answer', undo ? {} : { text: STEP_DONE_REPORT, action: 'respond' },
    dependencies, undo ? stored => !stored.resolved && !stored.answer : isStepDone);
}
