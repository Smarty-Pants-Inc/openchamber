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
const RUNNING = ['starting', 'awaiting-trust', 'ready-required'];
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
  return id;
}
const forgetRequestId = (key: string) => { try { sessionStorage.removeItem(key); } catch { /* no storage */ } };
/** The start this tab's request made, by exact id; never inferred. */
const ownStart = (operations: readonly NativeCreationState[], id: string | undefined) =>
  id ? operations.find(operation => operation.clientRequestId === id && RUNNING.includes(operation.phase)) : undefined;

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
    // The create response was lost. A fresh read (not a replay) may show the operation carrying this tab's exact
    // request id; only that one is continued. No id, no match, or an older gateway: the outcome stays unknown.
    const listed = requestId ? await opencodeClient.listNativeCreations(first.directory).catch(() => []) : [];
    const own = ownStart(listed, requestId);
    record();
    if (!own) throw first.error;
    await resumeNativeCreation(own);
    return await finish(key, record, wait);
  } else if (first) {
    return await finish(key, record, wait);
  }
  const directory = draft.directoryOverride ?? visibleProjects(useProjectsStore.getState())
    .find(project => project.id === draft.selectedProjectId)?.path ?? opencodeClient.getDirectory();
  const supported = directory ? await opencodeClient.supportsNativeCreation(directory)
    .catch(cause => { throw new NativeCreationError('unavailable', cause); }) : false;
  if (!supported) return;
  if (!isNativeDraftTarget(draft)) throw new NativeCreationError('target');
  record();
  // This tab's own start for this draft (after a reload, found by its exact request id) is continued. Any other start
  // still running here (another window, device or draft) is never taken over; the server refuses a second meanwhile.
  const own = ownStart(open, requestId);
  if (own) await resumeNativeCreation(own);
  else if (open.length > 0) throw new NativeCreationError('elsewhere');
  else await prepareNativeDraft(newRequestId(key));
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
