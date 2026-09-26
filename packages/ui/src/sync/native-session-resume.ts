import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * "Continue in a new Pi" on a Code-created session whose Pi ended (smarty-code#365). One click sends one request, with
 * the browser's own request id. Then only reads, never a second request:
 * - The answer names the new Pi's start. It is followed (read once a second, as Send follows a creation) until it is
 *   ready: the view then loads its history again, now live, not read-only. A start that stopped says so.
 * - A request whose outcome is not known (no reply, or a reply that could not be read) may still have started a Pi:
 *   'unknown', with Check again, which looks for that request id in the project's starts. Only a refusal the server
 *   explained (still running, open in a tab) is shown as one.
 */
export type ContinueStatus =
  | { status: 'starting'; requestId: string; operationId?: string }
  | { status: 'unknown'; requestId: string; operationId?: string; checked?: boolean }
  | { status: 'stopped' };

const POLL_MS = 1000, LIMIT_MS = 330_000; // The start's own deadline and receiving (gateway RESUME_MS).
const current = new Map<string, ContinueStatus>();
const listeners = new Set<() => void>();
const set = (sessionID: string, value: ContinueStatus | undefined) => {
  if (value) current.set(sessionID, value); else current.delete(sessionID);
  listeners.forEach(listener => listener());
};
const STOPPED = ['denied', 'cancelled', 'expired'];
export const resumeTiming = { poll: (ms: number) => new Promise<void>(done => setTimeout(done, ms)) };

export function useContinueStatus(sessionID: string | null | undefined): ContinueStatus | undefined {
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (sessionID ? current.get(sessionID) : undefined), () => undefined);
}

/** Follows the new Pi's start by reads until it is ready (the view reloads, live), stops, or its deadline passes. */
async function follow(directory: string, sessionID: string, requestId: string, first: NativeCreationState) {
  const began = Date.now();
  let now = first;
  for (;;) {
    if (now.phase === 'ready') {
      set(sessionID, undefined);
      await getImperativeSessionMessageLoader()?.ensure({ directory, sessionID }, { reason: 'navigation', force: true });
      return;
    }
    if (STOPPED.includes(now.phase)) { set(sessionID, { status: 'stopped' }); return; }
    set(sessionID, { status: 'starting', requestId, operationId: now.operationId });
    if (Date.now() - began > LIMIT_MS) { set(sessionID, { status: 'unknown', requestId, operationId: now.operationId }); return; }
    await resumeTiming.poll(POLL_MS);
    now = await opencodeClient.readNativeCreation(directory, now.operationId).catch(() => now);
  }
}

export async function continueEndedSession(directory: string, sessionID: string): Promise<void> {
  const requestId = crypto.randomUUID();
  set(sessionID, { status: 'starting', requestId });
  let start: NativeCreationState;
  try { start = await opencodeClient.resumeNativeSession(directory, sessionID, requestId); }
  catch (error) {
    // The server explained its refusal (it answered, and nothing was started): said in its own words.
    if (error instanceof NativeCreationError && error.detail !== undefined) { set(sessionID, undefined); throw error; }
    set(sessionID, { status: 'unknown', requestId }); return; // No reply, or none that could be read: outcome unknown.
  }
  await follow(directory, sessionID, requestId, start);
}

/** Check again after an unknown outcome: only reads. Its request's start, when listed, is followed; else still unknown. */
export async function checkContinue(directory: string, sessionID: string): Promise<void> {
  const known = current.get(sessionID);
  if (known?.status !== 'unknown') return;
  const listed = await opencodeClient.listNativeCreations(directory).catch(() => undefined);
  const start = listed?.find(operation => operation.clientRequestId === known.requestId || operation.operationId === known.operationId);
  if (start) { await follow(directory, sessionID, known.requestId, start); return; }
  set(sessionID, { ...known, checked: true });
}

/** Tests model a page load. */
export function resetContinueForPage(): void { current.clear(); listeners.forEach(listener => listener()); }
