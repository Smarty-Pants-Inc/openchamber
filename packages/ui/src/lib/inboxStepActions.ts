import { actOnInboxItem, InboxRequestError, loadInboxItem, type InboxItem } from './smartyInbox';
import { isStepDone, STEP_DONE_REPORT } from './inboxSteps';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from './runtime-switch';

export type StepActionResult =
  | { state: 'stored'; item: InboxItem }
  | { state: 'refused'; error?: string }
  | { state: 'uncertain'; item?: InboxItem };
type StepActionDependencies = {
  write: typeof actOnInboxItem;
  read: typeof loadInboxItem;
  operationKey: () => string;
};
const defaults: StepActionDependencies = {
  write: actOnInboxItem, read: loadInboxItem, operationKey: () => crypto.randomUUID(),
};

/** One conditional write. An unknown response permits only a read, never an automatic replay. */
export async function changeInboxStep(item: InboxItem, undo: boolean, dependencies = defaults): Promise<StepActionResult> {
  if (undo ? !isStepDone(item) : Boolean(item.resolved) || item.actions.length !== 1 || item.actions[0] !== 'respond') {
    return { state: 'refused' };
  }
  const scope = captureRuntimeRequestScope();
  try {
    const body = { updated: item.updated, opKey: dependencies.operationKey() };
    const stored = await dependencies.write(item.id, undo ? 'reopen' : 'answer', undo ? body : {
      ...body, text: STEP_DONE_REPORT, action: 'respond',
    });
    if (stored.id !== item.id || stored.to !== item.to || (undo ? stored.resolved || stored.answer : !isStepDone(stored))) {
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
