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
  const first = record();
  if (first?.status === 'failed' && !first.submitted || first?.status === 'pending' && STOPPED.includes(first.operation.phase)) {
    publishNativeCreation(first, null);
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
  // An earlier start in this project that is still running is continued, not started again.
  const open = operations.find(operation => operation.directory === draft.directoryOverride
    && operation.phase !== 'ready' && !STOPPED.includes(operation.phase));
  if (open) await resumeNativeCreation(open); else await prepareNativeDraft();
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
