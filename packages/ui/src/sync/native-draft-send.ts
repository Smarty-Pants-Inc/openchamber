import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSelectionStore } from './selection-store';
import { nativeCreationForDraft } from './native-draft-creation';
import { getImperativeSessionMessageLoader, type SessionMessageLoader } from './session-message-loader';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

type NativeDraftTarget = { draft: NewSessionDraftState; runtimeKey: string; session: NativeCreatedSession };
export type NativeDraftSend = NativeDraftTarget & { loader: SessionMessageLoader; view: string };
const pending = new Set<NativeCreatedSession>();

export function isNativeDraftCurrent(target: NativeDraftTarget): boolean {
  const store = useSessionUIStore.getState();
  const current = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, getRuntimeKey());
  return getRuntimeKey() === target.runtimeKey && current?.status === 'created' && !current.inputAccepted
    && current.session === target.session && store.newSessionDraft.draftId === target.draft.draftId;
}

function assertNativeDraftCurrent(target: NativeDraftTarget): void {
  if (!isNativeDraftCurrent(target)) throw new NativeCreationError('stale');
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

/** Admission is final even after navigation. Only the originating record changes. */
export function acceptNativeDraftSend(target: NativeDraftSend): void {
  const state = useSessionUIStore.getState();
  const original = nativeCreationForDraft(state.nativeDraftCreations, target.draft, target.runtimeKey);
  const visible = nativeCreationForDraft(state.nativeDraftCreations, state.newSessionDraft, getRuntimeKey());
  const nativeDraftCreations = new Map(state.nativeDraftCreations);
  for (const [key, record] of nativeDraftCreations) {
    if (record === original && record.status === 'created' && record.session === target.session) {
      nativeDraftCreations.set(key, { ...record, inputAccepted: true });
    }
  }
  useSessionUIStore.setState({ nativeDraftCreations });
  if (visible === original) resumeAcceptedNativeDraft();
}

/** Returning to a submitted draft opens its exact owner, never submits its input again. */
export function resumeAcceptedNativeDraft(): void {
  const store = useSessionUIStore.getState();
  const record = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, getRuntimeKey());
  if (record?.status === 'created' && record.inputAccepted) {
    const model = record.session.nativeCreation.model;
    useSelectionStore.getState().saveSessionModelSelection(record.session.id, model.providerID, model.modelID);
    store.setCurrentSession(record.session.id, record.session.directory, 'submitted-draft');
  }
}

export function beginNativeDraftSend(target: NativeDraftSend): () => void {
  assertNativeDraftReady(target);
  if (pending.has(target.session)) throw new NativeCreationError('sending');
  pending.add(target.session);
  return () => { pending.delete(target.session); };
}
