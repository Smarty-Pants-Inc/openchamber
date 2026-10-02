import { actOnInboxItem, inboxItemState, InboxRequestError, loadInboxItem, type InboxItem } from './smartyInbox';
import { isStepDone, STEP_DONE_REPORT } from './inboxSteps';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from './runtime-switch';

export type StepActionResult =
  | { state: 'stored'; item: InboxItem }
  | { state: 'refused'; error?: string }
  | { state: 'uncertain'; item?: InboxItem };
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
