import * as React from 'react';
import { z } from 'zod';
import type { Session } from '@opencode-ai/sdk/v2';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { isHerdrEnded, herdrSignature } from '@/lib/herdrSession';
import { isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { subscribeRuntimeAuthGenerationChanged } from '@/lib/runtime-auth';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { ManagedProject } from '@/lib/managed-project-catalog';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from './session-ui-store';
import type { ChildStoreManager } from './child-store';
import { useDirectoryStore, useSyncRuntime } from './sync-context';
import { getSyncSessions } from './sync-refs';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { checkSelectedSessionOwner, retainSelectedSessionOwner, getSelectedOwnerSelectionEpoch, hasActiveSelectedOwnerOperation,
  subscribeSelectedOwnerTransportReady } from './selected-owner-operation';
export { checkSelectedSessionOwner, retainSelectedSessionOwner } from './selected-owner-operation';

// Gateway1322 identity.ts emits this topology field. Status/model/cache presence is not pane liveness.
const paneSchema = z.object({ herdrPaneLive: z.boolean() });
export function readHerdrPaneLive(row: Session | undefined): boolean | undefined {
  const parsed = paneSchema.safeParse(row);
  return parsed.success ? parsed.data.herdrPaneLive : undefined;
}
type OwnerOutcome = { status: 'checking' | 'unknown'; reason?: string } | { status: 'live' | 'ended'; row: Session };
export type SelectedManagedOwner = OwnerOutcome & {
  sessionID: string; directory: string; scope: RuntimeRequestScope;
  catalog: ManagedProject[]; observation: string; selectionEpoch: number; adopted?: boolean;
};
const unavailable = { generation: null, sequence: 0, model: null, thinkingLevel: null } as const;
/** The owner observation of one row: what can change ownership, readiness or routing. Not time.updated. */
export const ownerRowKey = (row: Session | undefined) => JSON.stringify([row?.directory, row?.title, herdrSignature(row), readHerdrPaneLive(row),
  readOrdinaryModel(row), Boolean(row && 'smartyRetainedUnavailable' in row && row.smartyRetainedUnavailable)]);
type ScopedChildStores = Pick<ChildStoreManager, 'getState'>;
function getScopedSessions(directory: string, childStores?: ScopedChildStores): Session[] {
  return childStores ? childStores.getState(directory)?.session ?? [] : getSyncSessions(directory);
}
export function observation(sessionID: string, directory: string, childStores?: ScopedChildStores): string {
  return ownerRowKey(getScopedSessions(directory, childStores).find(row => row.id === sessionID)) + ownerRowKey(useGlobalSessionsStore.getState().entityById.get(sessionID));
}
export function needsSelectedOwnerCheck(sessionID: string, directory: string, childStores?: ScopedChildStores): boolean {
  if (!useProjectsStore.getState().managedCatalogAdmitted) return false;
  const local = getScopedSessions(directory, childStores).find(row => row.id === sessionID);
  const global = useGlobalSessionsStore.getState().entityById.get(sessionID);
  if (!readOrdinaryModel(local) && !readOrdinaryModel(global)) return false;
  return isHerdrEnded(local) || isHerdrEnded(global)
    || Boolean(global && ('smartyRetainedUnavailable' in global && global.smartyRetainedUnavailable || global.directory !== directory));
}
export function isSelectedOwnerCurrent(proof: SelectedManagedOwner, childStores?: ScopedChildStores): boolean {
  const selection = useSessionUIStore.getState();
  const projects = useProjectsStore.getState();
  return isRuntimeRequestScopeCurrent(proof.scope) && projects.managedCatalogAdmitted
    && projects.managedCatalogStatus === 'ready' && projects.managedRows === proof.catalog
    && selection.currentSessionId === proof.sessionID && selection.currentSessionDirectory === proof.directory
    && getSelectedOwnerSelectionEpoch() === proof.selectionEpoch && observation(proof.sessionID, proof.directory, childStores) === proof.observation;
}
/** Null is the unchanged healthy/stock path. Unknown is never ended and never writable. */
function hasWritableHistory(loader: ReturnType<typeof getImperativeSessionMessageLoader>, target: { sessionID: string; directory: string }, runtimeKey: string): boolean {
  const view = loader?.getSnapshot(target);
  return view?.resolved === true && view.readOnly === false && Boolean(loader?.getSendableOrdinaryView(target, runtimeKey));
}
function historyObservation(loader: ReturnType<typeof getImperativeSessionMessageLoader>, target: { sessionID: string; directory: string }, runtimeKey: string): string {
  const view = loader?.getSnapshot(target);
  return JSON.stringify([view?.status, view?.resolved, view?.readOnly, view?.ordinaryView,
    loader?.getSendableOrdinaryView(target, runtimeKey)]);
}
export function readSelectedSessionOwner(sessionID: string | null | undefined, directory: string | undefined, childStores?: ScopedChildStores,
  loader = getImperativeSessionMessageLoader()): OwnerOutcome | null {
  if (!sessionID || !directory || !useProjectsStore.getState().managedCatalogAdmitted) return null;
  const local = getScopedSessions(directory, childStores).find(row => row.id === sessionID);
  const global = useGlobalSessionsStore.getState().entityById.get(sessionID);
  const proof = useSessionUIStore.getState().selectedManagedOwner;
  // Explicit plain stock replacement drops proof. Absence of both native rows is not a stock observation.
  if (!readOrdinaryModel(local) && !readOrdinaryModel(global)
    && (local || global || proof?.sessionID !== sessionID)) return null;
  if (proof?.sessionID === sessionID && isSelectedOwnerCurrent(proof, childStores)) {
    if (proof.directory !== directory) return { status: 'unknown', reason: 'Owner directory changed' };
    if (proof.status === 'live' && !hasWritableHistory(loader, { sessionID, directory }, proof.scope.runtimeKey))
      return { status: 'checking' };
    return proof;
  }
  const suspicious = needsSelectedOwnerCheck(sessionID, directory, childStores);
  // A reconciled alias looks healthy precisely because we adopted it. Do not let a late losing row reclaim it.
  if (proof?.sessionID === sessionID && useSessionUIStore.getState().currentSessionId === sessionID
    && (proof.status === 'live' || proof.adopted || suspicious || !local && !global)) return { status: 'checking' };
  return suspicious ? { status: 'checking' } : null;
}
export function selectedOwnerOrdinaryState(sessionID: string, directory: string | undefined) {
  const owner = readSelectedSessionOwner(sessionID, directory);
  if (!owner) return undefined;
  return owner.status === 'live'
    ? readOrdinaryModel(getSyncSessions(owner.row.directory).find(row => row.id === sessionID)) ?? unavailable : unavailable;
}
/** Delays of the bounded delayed rechecks of an unknown owner while connected and catalog-ready. Test seam. */
export const selectedOwnerRecovery = { delaysMs: [2_000, 5_000, 15_000] };
export function useSelectedSessionOwner(sessionID: string | null | undefined, directory: string | undefined, historyReadOnly: boolean | undefined) {
  const { childStores, messageLoader, runtimeKey } = useSyncRuntime();
  const store = useDirectoryStore(directory ?? '', { bootstrap: false });
  const global = useGlobalSessionsStore(state => sessionID ? state.entityById.get(sessionID) : undefined);
  const catalog = useProjectsStore(state => state.managedRows);
  const catalogStatus = useProjectsStore(state => state.managedCatalogStatus);
  const proof = useSessionUIStore(state => state.selectedManagedOwner);
  const connected = useConfigStore(state => state.isConnected);
  const [recoveryRevision, recheck] = React.useReducer(value => value + 1, 0);
  const attemptedRevision = React.useRef(0);
  React.useEffect(retainSelectedSessionOwner, []);
  React.useEffect(() => {
    const stops = [subscribeRuntimeEndpointChanged(recheck), subscribeRuntimeAuthGenerationChanged(recheck)];
    return () => { for (const stop of stops) stop(); };
  }, []);
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = React.useCallback(() => sessionID && directory
    ? ownerRowKey(store.getState().session.find(row => row.id === sessionID)) : '', [store, sessionID, directory]);
  const key = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const subscribeHistory = React.useCallback((listener: () => void) => sessionID && directory
    ? messageLoader.subscribe({ sessionID, directory }, listener) : () => {}, [sessionID, directory, messageLoader]);
  const historySnapshot = React.useCallback(() => sessionID && directory
    ? historyObservation(messageLoader, { sessionID, directory }, runtimeKey) : '', [sessionID, directory, messageLoader, runtimeKey]);
  const historyKey = React.useSyncExternalStore(subscribeHistory, historySnapshot, historySnapshot);
  const wasConnected = React.useRef(connected);
  React.useEffect(() => {
    if (connected && !wasConnected.current) recheck();
    wasConnected.current = connected;
  }, [connected]);
  React.useEffect(() => {
    if (!sessionID || !directory) return;
    const target = { sessionID, directory };
    let previous = messageLoader.getSnapshot(target).status;
    return messageLoader.subscribe(target, () => {
      const next = messageLoader.getSnapshot(target).status;
      if (next === 'ready' && previous !== 'ready' && !hasActiveSelectedOwnerOperation()) recheck();
      previous = next;
    });
  }, [sessionID, directory, messageLoader, runtimeKey]);
  React.useEffect(() => {
    if (!sessionID || !directory || catalogStatus !== 'ready') return;
    const owner = readSelectedSessionOwner(sessionID, directory, childStores, messageLoader);
    const recovery = attemptedRevision.current !== recoveryRevision;
    attemptedRevision.current = recoveryRevision;
    const currentProof = proof && isSelectedOwnerCurrent(proof, childStores);
    const unusableLiveProof = currentProof && proof.status === 'live'
      && !hasWritableHistory(messageLoader, { sessionID, directory }, proof.scope.runtimeKey);
    // A later failed history read can strand an established owner while SSE stays healthy.
    // Spend one delayed replacement check, using the existing native CAS and loader retries.
    // Its failure becomes unknown, so it cannot schedule itself again without a recovery signal.
    if (unusableLiveProof && messageLoader.getSnapshot({ sessionID, directory }).status === 'error'
      && !hasActiveSelectedOwnerOperation()) {
      const timer = setTimeout(() => {
        if (useSessionUIStore.getState().selectedManagedOwner === proof && isSelectedOwnerCurrent(proof, childStores))
          void checkSelectedSessionOwner(sessionID, directory, childStores);
      }, 1_000);
      return () => clearTimeout(timer);
    }
    if (owner?.status === 'checking' && (!currentProof || unusableLiveProof && recovery) || owner?.status === 'unknown' && recovery)
      void checkSelectedSessionOwner(sessionID, directory, childStores);
  }, [sessionID, directory, key, historyKey, global, catalog, catalogStatus, recoveryRevision, historyReadOnly, proof, childStores, messageLoader]);
  const owner = readSelectedSessionOwner(sessionID, directory, childStores, messageLoader);
  // A check that failed while transport was down leaves unknown, and transport can return without a connection,
  // catalog or loader change. Two bounded paths recover it: the pipeline's transport-readiness signal, and a few
  // delayed rechecks per committed selection while connected and catalog-ready. The signal, a selection change and
  // live/ended refill the budget, so it is never spent for good; a session that stays unreachable stops polling.
  // Budget state changes only in committed effects and the signal's handler, never during render: an abandoned
  // render of another selection cannot reset or spend the committed selection's budget.
  const retries = React.useRef({ selection: '', spent: 0 });
  const selection = `${runtimeKey}\u0000${directory ?? ''}\u0000${sessionID ?? ''}`;
  const ownerStatus = owner?.status;
  React.useEffect(() => subscribeSelectedOwnerTransportReady(() => {
    retries.current = { ...retries.current, spent: 0 };
    recheck();
  }), []);
  React.useEffect(() => {
    if (retries.current.selection !== selection || ownerStatus === 'live' || ownerStatus === 'ended')
      retries.current = { selection, spent: 0 };
    const budget = retries.current, delay = selectedOwnerRecovery.delaysMs[budget.spent];
    if (ownerStatus !== 'unknown' || !connected || catalogStatus !== 'ready' || delay === undefined) return;
    const timer = setTimeout(() => {
      if (retries.current !== budget) return;
      budget.spent++;
      recheck(); // Reruns the check effect; an operation already in flight is shared, not duplicated.
    }, delay);
    return () => clearTimeout(timer);
  }, [ownerStatus, connected, catalogStatus, selection, recoveryRevision]);
  return owner;
}
