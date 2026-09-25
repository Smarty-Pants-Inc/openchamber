import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, nativeCreationFailure, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { isNativeDraftTarget, nativeCreationForDraft, prepareNativeDraft, publishNativeCreation } from './native-draft-creation';
import { refreshNativeCreation, replyNativeCreation, resumeNativeCreation } from './native-draft-control';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

/** Phases known to have started nothing that could take this message. */
const STOPPED = ['denied', 'cancelled', 'expired'];
const POLL_MS = 1000, LIMIT_MS = 120_000;
let running = false;
const listeners = new Set<() => void>();
const setRunning = (value: boolean) => { running = value; listeners.forEach(listener => listener()); };
/** True while Send is starting a session; the composer disables Send and says so. */
export function useNativeDraftStarting(): boolean {
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => running, () => false);
}

/**
 * This tab's create request id for a draft (smarty-code#126, OC#167 review): sessionStorage, so another window never
 * shares it and a reload of this tab keeps it. A lost create response is recovered only by an exact match on it.
 */
const requestKey = (draft: NewSessionDraftState, runtimeKey: string) =>
  `oc.nativeCreation.request:${JSON.stringify([runtimeKey, draft.draftId, draft.directoryOverride])}`;
const storedRequestId = (key: string) => { try { return sessionStorage.getItem(key) ?? undefined; } catch { return undefined; } };
function newRequestId(key: string): string {
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(key, id); } catch { /* no storage: the id still correlates within this page */ }
  listeners.forEach(listener => listener());
  return id;
}
const forgetRequestId = (key: string) => {
  try { sessionStorage.removeItem(key); } catch { /* no storage */ }
  listeners.forEach(listener => listener());
};

/** True while this draft has a create whose outcome is unknown (its saved id is unresolved). */
export function useUnresolvedNativeStart(draft: NewSessionDraftState, runtimeKey: string): boolean {
  const key = requestKey(draft, runtimeKey);
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => !running && storedRequestId(key) !== undefined, () => false);
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
  forgetRequestId(requestKey(draft, runtimeKey));
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
  if (!match || match.phase === 'unavailable') throw new NativeCreationError('unknown');
  return match;
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
  setRunning(true);
  try { await drive(operations, wait); } finally { setRunning(false); }
}

async function drive(operations: readonly NativeCreationState[], wait: (ms: number) => Promise<void>) {
  const draft = useSessionUIStore.getState().newSessionDraft, runtimeKey = getRuntimeKey();
  const record = () => {
    const state = useSessionUIStore.getState();
    if (getRuntimeKey() !== runtimeKey || !sameDraft(state.newSessionDraft, draft)) throw new NativeCreationError('stale');
    return nativeCreationForDraft(state.nativeDraftCreations, draft, runtimeKey);
  };
  const key = requestKey(draft, runtimeKey), requestId = storedRequestId(key);
  const open = operations.filter(operation => operation.directory === draft.directoryOverride
    && operation.phase !== 'ready' && !STOPPED.includes(operation.phase));
  const first = record();
  if (first?.status === 'failed' && !first.submitted || first?.status === 'pending' && STOPPED.includes(first.operation.phase)) {
    publishNativeCreation(first, null);
  } else if (first?.status === 'failed') {
    // The create response was lost: only this tab's exact request id can recover it (no id: an older gateway).
    if (!requestId) throw first.error;
    const saved = await resolveSaved(first.directory, requestId, key);
    record();
    if (saved === 'cleared') { publishNativeCreation(first, null); throw new NativeCreationError('stopped'); }
    await resumeNativeCreation(saved);
    return await finish(key, record, wait);
  } else if (first) {
    return await finish(key, record, wait);
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
    if (saved !== 'cleared') { await resumeNativeCreation(saved); return await finish(key, record, wait); }
  }
  // Any other start still running here (another window, device or draft) is never taken over; the server refuses a
  // second start meanwhile.
  if (open.length > 0) throw new NativeCreationError('elsewhere');
  record();
  try { await prepareNativeDraft(newRequestId(key)); }
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
  await finish(key, record, wait);
}

/** A settled start (or one known to have started nothing) needs no recovery id; an unknown one keeps it. */
async function finish(key: string, record: () => ReturnType<typeof nativeCreationForDraft>, wait: (ms: number) => Promise<void>) {
  try { await settle(record, wait); forgetRequestId(key); }
  catch (error) {
    if (error instanceof NativeCreationError && ['stopped', 'notReady'].includes(error.code)) forgetRequestId(key);
    throw error;
  }
}

async function settle(record: () => ReturnType<typeof nativeCreationForDraft>, wait: (ms: number) => Promise<void>) {
  const began = Date.now();
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
      if (phase === 'unavailable') throw new NativeCreationError('unknown');
      if (phase === 'awaiting-trust') { await answer('trust'); continue; }
      if (phase === 'ready-required') {
        if (!canInitialReady || !native) throw new NativeCreationError('notReady');
        await answer('ready'); continue;
      }
    }
    // Still starting: the operation is re-read, never created or answered again. Send again continues it.
    if (Date.now() - began > LIMIT_MS) throw new NativeCreationError('required');
    await wait(POLL_MS);
    const later = record();
    if (later?.status === 'pending' && !later.busy) await refreshNativeCreation().catch(cause => { throw nativeCreationFailure(cause); });
  }
}
