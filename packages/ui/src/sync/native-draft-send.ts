import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { nativeCreationForDraft } from './native-draft-creation';
import { getImperativeSessionMessageLoader, type SessionMessageLoader } from './session-message-loader';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

type NativeDraftTarget = { draft: NewSessionDraftState; runtimeKey: string; session: NativeCreatedSession };
export type NativeDraftSend = NativeDraftTarget & { loader: SessionMessageLoader; view: string };
const pending = new Set<NativeCreatedSession>();

export function assertNativeDraftCurrent(target: NativeDraftTarget): void {
  const store = useSessionUIStore.getState();
  const current = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, getRuntimeKey());
  if (getRuntimeKey() !== target.runtimeKey || current?.status !== 'created' || current.session !== target.session
    || store.newSessionDraft.draftId !== target.draft.draftId) throw new NativeCreationError('stale');
}

export async function prepareNativeDraftSend(draft: NewSessionDraftState, session: NativeCreatedSession): Promise<NativeDraftSend> {
  const target = { draft, session, runtimeKey: getRuntimeKey() };
  assertNativeDraftCurrent(target);
  const loader = getImperativeSessionMessageLoader();
  if (!loader) throw new NativeCreationError('history');
  const history = { directory: session.directory, sessionID: session.id };
  if (!loader.getAcceptedOrdinaryView(history, target.runtimeKey)) {
    await loader.ensure(history, { reason: 'navigation', force: loader.getSnapshot(history).resolved });
  }
  assertNativeDraftCurrent(target);
  // ensure resolves on stored errors too. Only the owning loader's accepted ready view permits dispatch.
  const view = loader.getAcceptedOrdinaryView(history, target.runtimeKey);
  if (loader !== getImperativeSessionMessageLoader() || !view) throw new NativeCreationError('history', loader.getSnapshot(history).error);
  return { ...target, loader, view };
}

export function assertNativeDraftReady(target: NativeDraftSend): void {
  assertNativeDraftCurrent(target);
  const history = { directory: target.session.directory, sessionID: target.session.id };
  if (target.loader !== getImperativeSessionMessageLoader()
    || target.loader.getAcceptedOrdinaryView(history, target.runtimeKey) !== target.view) throw new NativeCreationError('history');
}

export function beginNativeDraftSend(target: NativeDraftSend): () => void {
  assertNativeDraftReady(target);
  if (pending.has(target.session)) throw new NativeCreationError('sending');
  pending.add(target.session);
  return () => { pending.delete(target.session); };
}
