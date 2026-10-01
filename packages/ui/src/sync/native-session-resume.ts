import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * Continue an ended Code-created session in one new Pi (smarty-code#365). One POST carries the browser's request id;
 * subsequent recovery only reads. A start is followed until ready, stopped, or uncertain. Ready clears the pending
 * action only after the loader has accepted live history. Lost replies and failed reads remain unknown, not no-start.
 * Each record belongs to its runtime/directory/session. A follow loop cannot issue reads after its transport changes.
 */
export type ContinueStatus =
  | { status: 'starting'; requestId: string; operationId?: string }
  | { status: 'unknown'; requestId: string; operationId?: string; checked?: boolean }
  | { status: 'stopped' };

type ContinueTarget = { directory: string; sessionID: string; key: string; scope: RuntimeRequestScope };
const keyFor = (runtime: string, directory: string, sessionID: string) => JSON.stringify([runtime, directory, sessionID]);
const targetFor = (directory: string, sessionID: string): ContinueTarget => {
  const scope = captureRuntimeRequestScope();
  return { directory, sessionID, key: keyFor(scope.runtimeKey, directory, sessionID), scope };
};
const POLL_MS = 1000, LIMIT_MS = 330_000;
const current = new Map<string, ContinueStatus>();
const listeners = new Set<() => void>();
const set = (key: string, value: ContinueStatus | undefined) => {
  if (value) current.set(key, value); else current.delete(key);
  listeners.forEach(listener => listener());
};
const STOPPED = ['denied', 'cancelled', 'expired'];
export const resumeTiming = { poll: (ms: number) => new Promise<void>(done => setTimeout(done, ms)) };

export function useContinueStatus(sessionID: string | null | undefined, directory?: string): ContinueStatus | undefined {
  const key = sessionID && directory ? keyFor(getRuntimeKey(), directory, sessionID) : undefined;
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (key ? current.get(key) : undefined), () => undefined);
}

/** Follow only this operation's captured transport; the loader owns the read-only-to-live history transition. */
async function follow(target: ContinueTarget, requestId: string, first: NativeCreationState) {
  const began = Date.now();
  let now = first;
  const unknown = () => set(target.key, { status: 'unknown', requestId, operationId: now.operationId });
  for (;;) {
    if (!isRuntimeRequestScopeCurrent(target.scope) || now.directory !== target.directory) { unknown(); return; }
    if (now.phase === 'ready') {
      const loader = getImperativeSessionMessageLoader();
      if (!loader) { unknown(); return; }
      try { await loader.ensure({ directory: target.directory, sessionID: target.sessionID }, { reason: 'navigation', force: true }); }
      catch { unknown(); return; }
      if (!isRuntimeRequestScopeCurrent(target.scope)) { unknown(); return; }
      const view = loader.getSnapshot({ directory: target.directory, sessionID: target.sessionID });
      if (view.status !== 'ready' || !view.resolved || view.readOnly === true) { unknown(); return; }
      set(target.key, undefined);
      return;
    }
    if (STOPPED.includes(now.phase)) { set(target.key, { status: 'stopped' }); return; }
    set(target.key, { status: 'starting', requestId, operationId: now.operationId });
    if (Date.now() - began > LIMIT_MS) { unknown(); return; }
    await resumeTiming.poll(POLL_MS);
    if (!isRuntimeRequestScopeCurrent(target.scope)) { unknown(); return; }
    now = await opencodeClient.readNativeCreation(target.directory, now.operationId).catch(() => now);
  }
}

export async function continueEndedSession(directory: string, sessionID: string): Promise<void> {
  const target = targetFor(directory, sessionID);
  const known = current.get(target.key);
  if (known?.status === 'starting' || (known?.status === 'unknown' && known.checked !== true)) return;
  const requestId = crypto.randomUUID();
  set(target.key, { status: 'starting', requestId });
  let start: NativeCreationState;
  try { start = await opencodeClient.resumeNativeSession(directory, sessionID, requestId); }
  catch (error) {
    // A safe message alone is not proof of refusal: a 5xx may explicitly describe an unknown outcome.
    if (isRuntimeRequestScopeCurrent(target.scope) && error instanceof NativeCreationError && error.detail !== undefined
      && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408) {
      set(target.key, undefined); throw error;
    }
    set(target.key, { status: 'unknown', requestId }); return;
  }
  await follow(target, requestId, start);
}

/** Check again only reads. A failed list preserves unknown; only an answered list can say no matching start was listed. */
export async function checkContinue(directory: string, sessionID: string): Promise<void> {
  const target = targetFor(directory, sessionID);
  const known = current.get(target.key);
  if (known?.status !== 'unknown') return;
  const listed = await opencodeClient.listNativeCreations(directory).catch(() => undefined);
  if (!listed || !isRuntimeRequestScopeCurrent(target.scope)) {
    set(target.key, { status: 'unknown', requestId: known.requestId, operationId: known.operationId }); return;
  }
  const start = listed.find(operation => operation.clientRequestId === known.requestId || operation.operationId === known.operationId);
  if (start) { await follow(target, known.requestId, start); return; }
  set(target.key, { ...known, checked: true });
}

/** Tests model a page load. */
export function resetContinueForPage(): void { current.clear(); listeners.forEach(listener => listener()); }
