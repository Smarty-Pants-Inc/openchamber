import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { NATIVE_CREATION_DEADLINE_MS, withNativeCreationDeadline } from '@/lib/opencode/nativeCreationDeadline';
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
type ContinueRecord = { target: ContinueTarget; value: ContinueStatus };
const current = new Map<string, ContinueRecord>();
const listeners = new Set<() => void>();
const owns = (record: ContinueRecord) => current.get(record.target.key) === record;
const publish = (record: ContinueRecord, value: ContinueStatus | undefined) => {
  if (!owns(record)) return;
  if (value) record.value = value; else current.delete(record.target.key);
  listeners.forEach(listener => listener());
};
const claim = (target: ContinueTarget, value: ContinueStatus): ContinueRecord => {
  const record = { target, value };
  current.set(target.key, record);
  publish(record, value);
  return record;
};
const STOPPED = ['denied', 'cancelled', 'expired'];
export const resumeTiming = { poll: (ms: number) => new Promise<void>(done => setTimeout(done, ms)) };

export function useContinueStatus(sessionID: string | null | undefined, directory?: string): ContinueStatus | undefined {
  const key = sessionID && directory ? keyFor(getRuntimeKey(), directory, sessionID) : undefined;
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (key ? current.get(key)?.value : undefined), () => undefined);
}

/** Follow only this operation's captured transport; the loader owns the read-only-to-live history transition. */
async function follow(record: ContinueRecord, requestId: string, first: NativeCreationState) {
  const { target } = record;
  const began = Date.now();
  let now = first;
  const unknown = () => publish(record, { status: 'unknown', requestId, operationId: now.operationId });
  for (;;) {
    if (!owns(record)) return;
    if (!isRuntimeRequestScopeCurrent(target.scope) || now.directory !== target.directory) { unknown(); return; }
    if (now.phase === 'ready') {
      publish(record, { status: 'starting', requestId, operationId: now.operationId });
      if (!owns(record)) return;
      const loader = getImperativeSessionMessageLoader();
      if (!loader) { unknown(); return; }
      const historyTarget = { directory: target.directory, sessionID: target.sessionID };
      // Observation only: the shared loader read and queued freshness demand keep their independent lifetime.
      try { await withNativeCreationDeadline(() => {
        if (!owns(record) || !isRuntimeRequestScopeCurrent(target.scope) || getImperativeSessionMessageLoader() !== loader) {
          throw new NativeCreationError('unknown');
        }
        return loader.refreshTail(historyTarget, loader.getSnapshot(historyTarget).limit);
      }); }
      catch { unknown(); return; }
      if (!owns(record)) return;
      if (!isRuntimeRequestScopeCurrent(target.scope) || getImperativeSessionMessageLoader() !== loader) { unknown(); return; }
      const view = loader.getSnapshot({ directory: target.directory, sessionID: target.sessionID });
      if (view.status !== 'ready' || !view.resolved || view.readOnly === true) { unknown(); return; }
      publish(record, undefined);
      return;
    }
    if (STOPPED.includes(now.phase)) { publish(record, { status: 'stopped' }); return; }
    publish(record, { status: 'starting', requestId, operationId: now.operationId });
    const remaining = () => Math.min(NATIVE_CREATION_DEADLINE_MS, LIMIT_MS - (Date.now() - began));
    if (remaining() <= 0) { unknown(); return; }
    try { await withNativeCreationDeadline(() => resumeTiming.poll(POLL_MS), remaining()); }
    catch { unknown(); return; }
    if (!owns(record)) return;
    if (!isRuntimeRequestScopeCurrent(target.scope) || remaining() <= 0) { unknown(); return; }
    let next: NativeCreationState;
    try { next = await withNativeCreationDeadline(() => opencodeClient.readNativeCreation(target.directory, now.operationId), remaining()); }
    catch { unknown(); return; }
    if (!owns(record)) return;
    if (!isRuntimeRequestScopeCurrent(target.scope)) { unknown(); return; }
    now = next;
  }
}

export async function continueEndedSession(directory: string, sessionID: string): Promise<void> {
  const target = targetFor(directory, sessionID);
  const known = current.get(target.key)?.value;
  if (known?.status === 'starting' || (known?.status === 'unknown' && known.checked !== true)) return;
  const requestId = crypto.randomUUID();
  const record = claim(target, { status: 'starting', requestId });
  let start: NativeCreationState;
  try { start = await opencodeClient.resumeNativeSession(directory, sessionID, requestId); }
  catch (error) {
    if (!owns(record)) return;
    // A safe message alone is not proof of refusal: a 5xx may explicitly describe an unknown outcome.
    if (isRuntimeRequestScopeCurrent(target.scope) && error instanceof NativeCreationError && error.detail !== undefined
      && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408) {
      publish(record, undefined); throw error;
    }
    publish(record, { status: 'unknown', requestId }); return;
  }
  if (!owns(record)) return;
  if (!isRuntimeRequestScopeCurrent(target.scope)) { publish(record, { status: 'unknown', requestId }); return; }
  await follow(record, requestId, start);
}

/** Check again only reads. A failed list preserves unknown; only an answered list can say no matching start was listed. */
export async function checkContinue(directory: string, sessionID: string): Promise<void> {
  const target = targetFor(directory, sessionID);
  const known = current.get(target.key)?.value;
  if (known?.status !== 'unknown') return;
  const record = claim(target, known);
  const listed = await opencodeClient.listNativeCreations(directory).catch(() => undefined);
  if (!owns(record)) return;
  if (!listed || !isRuntimeRequestScopeCurrent(target.scope)) {
    publish(record, { status: 'unknown', requestId: known.requestId, operationId: known.operationId }); return;
  }
  const start = listed.find(operation => operation.clientRequestId === known.requestId || operation.operationId === known.operationId);
  if (start) { await follow(record, known.requestId, start); return; }
  publish(record, { ...known, checked: true });
}

/** Tests model a page load. */
export function resetContinueForPage(): void { current.clear(); listeners.forEach(listener => listener()); }
