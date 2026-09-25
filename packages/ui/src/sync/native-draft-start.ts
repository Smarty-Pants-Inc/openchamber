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

// Operations this browser started: ids from its create responses, or bound after a lost response (below).
// ponytail: localStorage, not a server request id. The gateway's create takes no client id; one would let a lost
// response bind by id instead of by the list difference.
const MINE_KEY = 'oc.nativeCreation.mine';
const mine = (): string[] => {
  try { const ids: unknown = JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]'); return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []; }
  catch { return []; }
};
const remember = (id: string) => {
  try { localStorage.setItem(MINE_KEY, JSON.stringify([...mine().filter(known => known !== id), id].slice(-20))); } catch { /* unavailable storage */ }
};
export const isOwnNativeCreation = (operationId: string) => mine().includes(operationId);
/** Per draft, the operations listed just before its create request: a lost response binds only a start new since. */
const listedBefore = new Map<string, Set<string>>();
const draftKey = (draft: NewSessionDraftState, runtimeKey: string) => JSON.stringify([runtimeKey, draft.draftId, draft.directoryOverride]);
const RUNNING_PHASES = ['starting', 'awaiting-trust', 'ready-required'];
/** After a lost create response: the one start in this project that is new since this browser's create request. */
export function lostNativeStart(draft: NewSessionDraftState, runtimeKey: string, operations: readonly NativeCreationState[]) {
  const before = listedBefore.get(draftKey(draft, runtimeKey));
  const fresh = before ? operations.filter(operation => operation.directory === draft.directoryOverride
    && RUNNING_PHASES.includes(operation.phase) && !before.has(operation.operationId)) : [];
  return fresh.length === 1 ? fresh[0] : undefined;
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
  const open = operations.filter(operation => operation.directory === draft.directoryOverride
    && operation.phase !== 'ready' && !STOPPED.includes(operation.phase));
  const first = record();
  if (first?.status === 'failed' && !first.submitted || first?.status === 'pending' && STOPPED.includes(first.operation.phase)) {
    publishNativeCreation(first, null);
  } else if (first?.status === 'failed') {
    // The create response was lost. A fresh read (not a replay) may show the start this browser's request made:
    // exactly one running start that was not listed before the request. Continue it; never create again.
    const listed = await opencodeClient.listNativeCreations(first.directory).catch(() => []);
    const lost = lostNativeStart(draft, runtimeKey, listed);
    if (!lost) throw first.error;
    remember(lost.operationId);
    await resumeNativeCreation(lost);
    return await settle(record, wait);
  } else if (first) {
    return await settle(record, wait);
  }
  const directory = draft.directoryOverride ?? visibleProjects(useProjectsStore.getState())
    .find(project => project.id === draft.selectedProjectId)?.path ?? opencodeClient.getDirectory();
  const supported = directory ? await opencodeClient.supportsNativeCreation(directory)
    .catch(cause => { throw new NativeCreationError('unavailable', cause); }) : false;
  if (!supported) return;
  if (!isNativeDraftTarget(draft)) throw new NativeCreationError('target');
  record();
  // This browser's earlier start that is still running is continued. Someone else's start (another window or
  // device of the same account) is never taken over; the server refuses a second start meanwhile.
  const own = open.find(operation => isOwnNativeCreation(operation.operationId));
  if (own) await resumeNativeCreation(own);
  else if (open.length > 0) throw new NativeCreationError('elsewhere');
  else {
    const before = draft.directoryOverride ? await opencodeClient.listNativeCreations(draft.directoryOverride).catch(() => null) : null;
    if (before) listedBefore.set(draftKey(draft, runtimeKey), new Set(before.map(operation => operation.operationId)));
    await prepareNativeDraft();
    const started = record();
    if (started?.status === 'pending') remember(started.operation.operationId);
  }
  await settle(record, wait);
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
