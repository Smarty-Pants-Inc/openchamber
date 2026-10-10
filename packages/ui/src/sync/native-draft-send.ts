import { NativeCreationError, type NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSelectionStore } from './selection-store';
import { assertManagedDraftTarget, nativeCreationForDraft } from './native-draft-creation';
import { admitSentStart, ensureSentStart, holdSentStart, releaseSentStart } from './native-draft-sent';
import { getImperativeSessionMessageLoader, type SessionMessageLoader } from './session-message-loader';
import { useSessionUIStore, type NewSessionDraftState, type SessionRevealTicket } from './session-ui-store';

type NativeDraftTarget = { draft: NewSessionDraftState; runtimeKey: string; session: NativeCreatedSession };
/** `clientRequestId`: the start this Send continues; its sent mark (#117) is this Send's, never a newer one. */
export type NativeDraftSend = NativeDraftTarget & { loader: SessionMessageLoader; view: string; clientRequestId?: string;
  revealTicket?: SessionRevealTicket };
const pending = new Set<NativeCreatedSession>();

/**
 * Sends on an open draft between the press and their end (admitted, refused or stopped), one hold per press, with the
 * draft target it was pressed for. Opening the draft's own new session meanwhile (its row appears as soon as it
 * starts) would end that Send before its message goes (smarty-dev#856); the Send opens the session itself once the
 * message is admitted. Only the press that took a hold ends it, so another press or target never releases it.
 */
export type FirstSendHold = { runtimeKey: string; draftId: number; projectId: string | null; directory: string | null; began: number };
const firstSends = new Set<FirstSendHold>();
const FIRST_SEND_LIMIT_MS = 180_000; // A Send that never reports back (a lost exit) stops holding after this.
export function beginFirstSend(draft: NewSessionDraftState, runtimeKey: string): FirstSendHold {
  const hold = { runtimeKey, draftId: draft.draftId, projectId: draft.selectedProjectId ?? null, directory: draft.directoryOverride ?? null, began: Date.now() };
  firstSends.add(hold);
  return hold;
}
export function endFirstSend(hold: FirstSendHold | undefined): void { if (hold) firstSends.delete(hold); }
/** True when `sessionId` is the open draft's own new session and a Send pressed for that same target is under way. */
export function isFirstSendInFlightFor(sessionId: string): boolean {
  const store = useSessionUIStore.getState(), draft = store.newSessionDraft, runtimeKey = getRuntimeKey(), now = Date.now();
  if (!draft.open) return false;
  const held = [...firstSends].some(hold => hold.runtimeKey === runtimeKey && hold.draftId === draft.draftId
    && hold.projectId === (draft.selectedProjectId ?? null) && hold.directory === (draft.directoryOverride ?? null)
    && now - hold.began <= FIRST_SEND_LIMIT_MS);
  if (!held) return false;
  const record = nativeCreationForDraft(store.nativeDraftCreations, draft, runtimeKey);
  if (record?.status === 'created') return !record.inputAccepted && record.session.id === sessionId;
  return record?.status === 'pending' && record.operation.native?.id === sessionId;
}

export function isNativeDraftCurrent(target: NativeDraftTarget): boolean {
  const store = useSessionUIStore.getState();
  const current = nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, getRuntimeKey());
  return getRuntimeKey() === target.runtimeKey && current?.status === 'created' && !current.inputAccepted
    && current.session === target.session && store.newSessionDraft.draftId === target.draft.draftId;
}

function assertNativeDraftCurrent(target: NativeDraftTarget): void {
  if (!isNativeDraftCurrent(target)) throw new NativeCreationError('stale');
  assertManagedDraftTarget(target.draft, target.session.directory);
}

export async function prepareNativeDraftSend(draft: NewSessionDraftState, session: NativeCreatedSession,
  revealTicket?: SessionRevealTicket): Promise<NativeDraftSend> {
  const target = { draft, session, runtimeKey: getRuntimeKey() };
  const created = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, target.runtimeKey);
  const clientRequestId = created?.status === 'created' && created.session === session ? created.clientRequestId : undefined;
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
  return { ...target, loader, view, clientRequestId, revealTicket };
}

/**
 * Every check of a native Send, the last one immediately before its prompt POST (the store's beforeDispatch), also
 * requires its accepted start's durable mark, so a page closed after admission never leaves the text as a draft to
 * send again (#117). A mark another tab removed meanwhile is written again; one that cannot be stored stops the Send.
 */
export function assertNativeDraftReady(target: NativeDraftSend): void {
  assertNativeDraftCurrent(target);
  if (target.clientRequestId && target.draft.directoryOverride) {
    const marked = ensureSentStart(target.runtimeKey, target.draft.directoryOverride, target.clientRequestId, submittedTexts.get(target));
    if (marked !== 'marked') throw new NativeCreationError(marked);
  }
  const history = { directory: target.session.directory, sessionID: target.session.id };
  if (target.loader !== getImperativeSessionMessageLoader()
    || target.loader.getAcceptedOrdinaryView(history, target.runtimeKey) !== target.view) throw new NativeCreationError('history');
}

/** Admission is final even after navigation. Only the originating record changes. */
/** The composer text each native Send submits: only the sender's tab lineage consumes copies on admission (#117). */
/** With when it was submitted: copies set later (a new draft typed while the POST was held) are newer messages. */
const submittedTexts = new WeakMap<NativeDraftSend, { text: string; at: number }>();
export function noteNativeDraftSubmitted(target: NativeDraftSend, text: string, at = Date.now()): void { submittedTexts.set(target, { text, at }); }

export function acceptNativeDraftSend(target: NativeDraftSend): void {
  const submitted = submittedTexts.get(target);
  // Delivered: the start's text is no longer pending anywhere (#117).
  if (target.draft.directoryOverride) {
    admitSentStart(target.runtimeKey, target.draft.directoryOverride, target.clientRequestId, submitted?.text, submitted?.at);
  }
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
  // While its prompt POST is in flight, the project-wide sent-start guard remains pending (#117).
  if (target.clientRequestId) holdSentStart(target.clientRequestId);
  return () => {
    pending.delete(target.session);
    // This Send settled: another tab may now read what became of its text (#117).
    releaseSentStart(target.clientRequestId);
  };
}
