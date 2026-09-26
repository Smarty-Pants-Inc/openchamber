import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, nativeCreationFailure, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { isNativeDraftTarget, nativeCreationForDraft, prepareNativeDraft, publishNativeCreation, ownSettledStarts, STOPPED_PHASES, startsElsewhere } from './native-draft-creation';
import { abandonedNativeCreations, abandonNativeCreation, refreshNativeCreation, replyNativeCreation, resumeNativeCreation } from './native-draft-control';
import { clearSentStart, ensureSentStart, holdSentStart, markSentStart, releaseSentStart, resolveSentStart, sentStartLocks } from './native-draft-sent';
import { discoveryPendingNow } from '@/lib/managed-discovery';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';
import { forgetRequestId, newRequestId, notifyDraftStart, requestKey, storedRequestId, subscribeDraftStart } from './native-draft-intent';
import { resetNativeDraftPage as resetDraftIntentPage } from './native-draft-intent';
/** A page load: no claimed drafts, and no remembered settled starts; tests call this to model a reload of the same tab. */
export function resetNativeDraftPage(): void { resetDraftIntentPage(); ownSettledStarts.clear(); }

/**
 * This tab's own start for the draft: its saved request, or the one this page still holds in memory (after the start
 * settled, until its text is admitted). The tab continues it itself, so its own mark never locks it (native-draft-sent).
 */
export function ownNativeRequestId(draft: NewSessionDraftState, runtimeKey: string): string | undefined {
  const saved = storedRequestId(requestKey(draft, runtimeKey));
  if (saved) return saved;
  const held = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, runtimeKey);
  if (held?.status === 'created') return held.inputAccepted ? undefined : held.clientRequestId;
  return held?.status === 'pending' ? held.operation.clientRequestId : undefined;
}

const STOPPED = STOPPED_PHASES;
const POLL_MS = 1000, LIMIT_MS = 120_000;
let running = false;
const setRunning = (value: boolean) => { running = value; notifyDraftStart(); };
/** True while Send is starting a session; the composer disables Send and says so. */
export function useNativeDraftStarting(): boolean {
  return React.useSyncExternalStore(subscribeDraftStart, () => running, () => false);
}

/** True while this draft has a create whose outcome is unknown (its saved id is unresolved). */
export function useUnresolvedNativeStart(draft: NewSessionDraftState, runtimeKey: string): boolean {
  const key = requestKey(draft, runtimeKey);
  return React.useSyncExternalStore(subscribeDraftStart, () => !running && storedRequestId(key) !== undefined, () => false);
}

/**
 * The person's explicit escape from an unknown start (smarty-code#126: never a dead end): forget this draft's saved
 * request and its unknown outcome, so the next Send starts exactly one new session. A session the lost request did
 * start stays where it is, in the sidebar.
 */
export function startNativeDraftAgain(): void {
  const state = useSessionUIStore.getState(), draft = state.newSessionDraft, runtimeKey = getRuntimeKey();
  if (running) return;
  const record = nativeCreationForDraft(state.nativeDraftCreations, draft, runtimeKey);
  if (record?.status === 'failed') publishNativeCreation(record, null);
  forgetOwnStart(draft, runtimeKey);
}

/** Forget this draft's own start: its saved request id and its sent mark (only that request's, never a newer one). */
function forgetOwnStart(draft: NewSessionDraftState, runtimeKey: string) {
  const key = requestKey(draft, runtimeKey), id = storedRequestId(key);
  forgetRequestId(key);
  if (draft.directoryOverride) clearSentStart(runtimeKey, draft.directoryOverride, id);
}

/**
 * "Start a new session instead" for a start that stays unreadable (smarty-code#340): the server settles it cancelled
 * for good (never sent to, even if it becomes ready), and only then this draft forgets it; the caller's Send then starts
 * exactly one new session. False when there is nothing to abandon; a refused abandon throws and keeps the start.
 */
export async function startNativeDraftInstead(): Promise<boolean> {
  const draft = useSessionUIStore.getState().newSessionDraft, runtimeKey = getRuntimeKey();
  if (running || !await abandonNativeCreation()) return false;
  forgetOwnStart(draft, runtimeKey);
  return true;
}
/**
 * A saved request id is an outstanding create whose outcome this tab does not know. It blocks any new create until a
 * fresh read resolves it: an exact match still running (or ready) is continued; a match the server reports as
 * stopped started nothing and clears the id. No match, including an empty list, proves nothing: the outcome stays
 * unknown and nothing is created or sent. Starting a new session (a new draft) is the explicit way to start again.
 */
async function resolveSaved(directory: string, id: string, key: string): Promise<NativeCreationState | 'cleared'> {
  const listed = await opencodeClient.listNativeCreations(directory).catch(cause => { throw new NativeCreationError('unknown', cause); });
  const match = listed.find(operation => operation.clientRequestId === id && operation.directory === directory);
  if (match && STOPPED.includes(match.phase)) { forgetRequestId(key); return 'cleared'; }
  if (!match) throw new NativeCreationError('unknown');
  return match; // An 'unavailable' match is continued too: settle() re-reads it until its limit.
}

const sameDraft = (a: NewSessionDraftState, b: NewSessionDraftState) => a.draftId === b.draftId
  && a.directoryOverride === b.directoryOverride && a.selectedProjectId === b.selectedProjectId;

/**
 * Send on a new-session draft (smarty-code#126, Paul's 2026-09-25 attempt): start the session in the draft's project
 * and wait until it takes input, so the caller's Send delivers the message once. Pressing Send in the chosen project is
 * the person's consent, so the session-only trust question and the first-input step are answered here.
 * It creates at most once per draft: an outcome not known to have started nothing is never retried, only re-read.
 * A stock backend (no native creation) returns at once and Send goes the ordinary way.
 */
export async function startNativeDraft(operations: readonly NativeCreationState[], wait = (ms: number) =>
  new Promise<void>(done => setTimeout(done, ms))): Promise<void> {
  if (running) throw new NativeCreationError('sending');
  // Projects not discovered yet (G13): the draft's directory may be the home fallback, so nothing starts; Send says
  // to wait for the project, and the message stays.
  if (discoveryPendingNow()) throw new NativeCreationError('target');
  setRunning(true);
  // The request this start continues or makes: this page holds its sending lock (#117) while it starts; the prompt
  // POST holds it again (native-draft-send). Between the two, other tabs read the sent text as unknown, never unsent.
  let request: string | undefined;
  const hold = (id: string | undefined) => { request = id; if (id) holdSentStart(id); };
  try { await drive(operations, wait, hold); }
  finally { releaseSentStart(request); setRunning(false); }
}

async function drive(operations: readonly NativeCreationState[], wait: (ms: number) => Promise<void>,
  hold: (id: string | undefined) => void) {
  const draft = useSessionUIStore.getState().newSessionDraft, runtimeKey = getRuntimeKey();
  const record = () => {
    const state = useSessionUIStore.getState();
    if (getRuntimeKey() !== runtimeKey || !sameDraft(state.newSessionDraft, draft)) throw new NativeCreationError('stale');
    return nativeCreationForDraft(state.nativeDraftCreations, draft, runtimeKey);
  };
  const key = requestKey(draft, runtimeKey), requestId = storedRequestId(key);
  // An accepted start recovered by its request id: its text is sent (#117) before anything is sent to it.
  const recovered = (directory: string, id: string) => {
    const marked = ensureSentStart(runtimeKey, directory, id);
    if (marked !== 'marked') throw new NativeCreationError(marked);
    hold(id);
  };
  // A start this page abandoned is settled for good even when the caller's list predates that (#340).
  const notAbandoned = (list: readonly NativeCreationState[]) => list.filter(operation => !abandonedNativeCreations.has(operation.operationId));
  const first = record();
  if (first?.status === 'failed' && !first.submitted || first?.status === 'pending' && STOPPED.includes(first.operation.phase)) {
    publishNativeCreation(first, null);
  } else if (first?.status === 'failed') {
    // The create response was lost: only this tab's exact request id can recover it (no id: an older gateway).
    if (!requestId) throw first.error;
    const saved = await resolveSaved(first.directory, requestId, key);
    record();
    if (saved === 'cleared') { publishNativeCreation(first, null); throw new NativeCreationError('stopped'); }
    recovered(first.directory, requestId);
    await resumeNativeCreation(saved);
    return await finish(key, record, wait, () => clearSentStart(runtimeKey, first.directory, requestId));
  } else if (first) {
    // A start this page still holds (its Send left for another project and came back): accepted with this tab's id,
    // it takes the sent mark before its text goes, as a recovered start does (#117).
    const echoed = first.status === 'pending' ? first.operation.clientRequestId : first.status === 'created' ? first.clientRequestId : undefined;
    if (!requestId || echoed !== requestId) { hold(requestId); return await finish(key, record, wait); }
    recovered(first.directory, requestId);
    return await finish(key, record, wait, () => clearSentStart(runtimeKey, first.directory, requestId));
  }
  const directory = draft.directoryOverride ?? visibleProjects(useProjectsStore.getState())
    .find(project => project.id === draft.selectedProjectId)?.path ?? opencodeClient.getDirectory();
  const supported = directory ? await opencodeClient.supportsNativeCreation(directory)
    .catch(cause => { throw new NativeCreationError('unavailable', cause); }) : false;
  if (!supported) return;
  if (!isNativeDraftTarget(draft) || !draft.directoryOverride) throw new NativeCreationError('target');
  record();
  if (requestId) {
    // After a reload the record is gone but the saved id is not: resolve it by a fresh read, never by the snapshot.
    const saved = await resolveSaved(draft.directoryOverride, requestId, key);
    record();
    if (saved !== 'cleared') {
      recovered(draft.directoryOverride, requestId);
      await resumeNativeCreation(saved);
      return await finish(key, record, wait, () => clearSentStart(runtimeKey, draft.directoryOverride!, requestId));
    }
  }
  // Any other start still running here (another window, device or draft) is never taken over; the server refuses a
  // second start meanwhile. The composer's snapshot may predate a start settling (smarty-code#114: read 0.8 s before
  // this page's own first start turned ready), so only a fresh read refuses.
  if (startsElsewhere(notAbandoned(operations), runtimeKey, draft.directoryOverride).length > 0) {
    const fresh = await opencodeClient.listNativeCreations(draft.directoryOverride)
      .catch(cause => { throw new NativeCreationError('unavailable', cause); });
    record();
    if (startsElsewhere(notAbandoned(fresh), runtimeKey, draft.directoryOverride).length > 0) throw new NativeCreationError('elsewhere');
  }
  // Another tab sent this project's draft text (#117): resolve it first; its text is never sent again from here.
  const sent = await resolveSentStart(runtimeKey, draft.directoryOverride, draft.draftId);
  if (sent === 'delivered' || sentStartLocks(sent)) throw new NativeCreationError('elsewhere');
  record();
  const id = newRequestId(key);
  try { await prepareNativeDraft(id); }
  catch (error) {
    // A failure known to precede the create request sent nothing with this id.
    const failed = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, runtimeKey);
    if (failed?.status === 'failed' && !failed.submitted) forgetRequestId(key);
    throw error;
  }
  // A create-only server returns the session before it takes input (its readiness belongs to its own terminal). This
  // Send made it, so it sends nothing: a message is never a readiness probe. A later Send sends to it once it is ready.
  const made = record();
  if (made?.status === 'created' && !made.session.nativeCreation.inputReady) { forgetRequestId(key); throw new NativeCreationError('notReady'); }
  // The server accepted this start with its request id: its text is sent, not a draft, until the start resolves (#117).
  if (made?.status === 'pending' && made.operation.clientRequestId === id) { markSentStart(runtimeKey, draft.directoryOverride, id); hold(id); }
  await finish(key, record, wait, () => clearSentStart(runtimeKey, draft.directoryOverride!, id));
}

/** A settled start (or one known to have started nothing) needs no recovery id; an unknown one keeps it. */
async function finish(key: string, record: () => ReturnType<typeof nativeCreationForDraft>, wait: (ms: number) => Promise<void>,
  startedNothing = () => {}) {
  try { await settle(record, wait); forgetRequestId(key); }
  catch (error) {
    // Known to have started nothing: this live page keeps the text as its own unsent draft.
    if (error instanceof NativeCreationError && ['stopped', 'notReady'].includes(error.code)) { forgetRequestId(key); startedNothing(); }
    throw error;
  }
}

async function settle(record: () => ReturnType<typeof nativeCreationForDraft>, wait: (ms: number) => Promise<void>) {
  const began = Date.now(); let unreadable = false;
  const answer = (action: 'trust' | 'ready') => replyNativeCreation(action).catch(cause => { throw nativeCreationFailure(cause); });
  for (;;) {
    const now = record();
    if (!now) throw new NativeCreationError('stale');
    if (now.status === 'created') return;
    if (now.status === 'failed') throw now.error;
    if (now.status === 'pending' && now.error) throw now.error;
    if (now.status === 'pending' && !now.busy) {
      const { phase, canInitialReady, native } = now.operation;
      if (STOPPED.includes(phase)) throw new NativeCreationError('stopped');
      // Not readable for a moment (its Pi still starting): re-read below, never answer or create (#126, 3.18 walk).
      unreadable = now.unreadable === true || phase === 'unavailable';
      if (!unreadable && phase === 'awaiting-trust') { await answer('trust'); continue; }
      // The owner reports 'ready' a moment after its first-input answer (#117: it was POSTed twice): re-read, once only.
      if (!unreadable && phase === 'ready-required' && !now.readyReplied) {
        if (!canInitialReady || !native) throw new NativeCreationError('notReady');
        await answer('ready'); continue;
      }
    }
    // Still starting (or not readable): re-read, never created or answered again; at the limit, required (or unknown).
    if (Date.now() - began > LIMIT_MS) throw new NativeCreationError(unreadable ? 'unknown' : 'required');
    await wait(POLL_MS);
    const later = record();
    if (later?.status === 'pending' && !later.busy) await refreshNativeCreation().catch(cause => { throw nativeCreationFailure(cause); });
  }
}
