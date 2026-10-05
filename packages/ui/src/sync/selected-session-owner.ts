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
import { getSyncChildStores, getSyncSessions } from './sync-refs';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { checkSelectedSessionOwner, retainSelectedSessionOwner, getSelectedOwnerSelectionEpoch, hasActiveSelectedOwnerOperation } from './selected-owner-operation';
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
const rowKey = (row: Session | undefined) => JSON.stringify([row?.directory, herdrSignature(row), readHerdrPaneLive(row),
  readOrdinaryModel(row), Boolean(row && 'smartyRetainedUnavailable' in row && row.smartyRetainedUnavailable)]);
export function observation(sessionID: string, directory: string): string {
  return rowKey(getSyncSessions(directory).find(row => row.id === sessionID)) + rowKey(useGlobalSessionsStore.getState().entityById.get(sessionID));
}
export function needsSelectedOwnerCheck(sessionID: string, directory: string): boolean {
  if (!useProjectsStore.getState().managedCatalogAdmitted) return false;
  const local = getSyncSessions(directory).find(row => row.id === sessionID);
  const global = useGlobalSessionsStore.getState().entityById.get(sessionID);
  if (!readOrdinaryModel(local) && !readOrdinaryModel(global)) return false;
  return isHerdrEnded(local) || isHerdrEnded(global)
    || Boolean(global && ('smartyRetainedUnavailable' in global && global.smartyRetainedUnavailable || global.directory !== directory));
}
export function isSelectedOwnerCurrent(proof: SelectedManagedOwner): boolean {
  const selection = useSessionUIStore.getState();
  const projects = useProjectsStore.getState();
  return isRuntimeRequestScopeCurrent(proof.scope) && projects.managedCatalogAdmitted
    && projects.managedCatalogStatus === 'ready' && projects.managedRows === proof.catalog
    && selection.currentSessionId === proof.sessionID && selection.currentSessionDirectory === proof.directory
    && getSelectedOwnerSelectionEpoch() === proof.selectionEpoch && observation(proof.sessionID, proof.directory) === proof.observation;
}
/** Null is the unchanged healthy/stock path. Unknown is never ended and never writable. */
export function readSelectedSessionOwner(sessionID: string | null | undefined, directory: string | undefined): OwnerOutcome | null {
  if (!sessionID || !directory || !useProjectsStore.getState().managedCatalogAdmitted) return null;
  const local = getSyncSessions(directory).find(row => row.id === sessionID);
  const global = useGlobalSessionsStore.getState().entityById.get(sessionID);
  const proof = useSessionUIStore.getState().selectedManagedOwner;
  // Explicit plain stock replacement drops proof. Absence of both native rows is not a stock observation.
  if (!readOrdinaryModel(local) && !readOrdinaryModel(global)
    && (local || global || proof?.sessionID !== sessionID)) return null;
  if (proof?.sessionID === sessionID && isSelectedOwnerCurrent(proof)) {
    if (proof.directory !== directory) return { status: 'unknown', reason: 'Owner directory changed' };
    if (proof.status === 'live') {
      const loader = getImperativeSessionMessageLoader();
      const target = { sessionID, directory };
      const view = loader?.getSnapshot(target);
      if (!view?.resolved || view.readOnly !== false
        || !loader?.getSendableOrdinaryView(target, proof.scope.runtimeKey)) return { status: 'checking' };
    }
    return proof;
  }
  const suspicious = needsSelectedOwnerCheck(sessionID, directory);
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
export function useSelectedSessionOwner(sessionID: string | null | undefined, directory: string | undefined, historyReadOnly: boolean | undefined) {
  const global = useGlobalSessionsStore(state => sessionID ? state.entityById.get(sessionID) : undefined);
  const catalog = useProjectsStore(state => state.managedRows);
  const catalogStatus = useProjectsStore(state => state.managedCatalogStatus);
  const proof = useSessionUIStore(state => state.selectedManagedOwner);
  const connected = useConfigStore(state => state.isConnected);
  const [runtimeRevision, recheck] = React.useReducer(value => value + 1, 0);
  const attemptedRevision = React.useRef(0);
  React.useEffect(retainSelectedSessionOwner, []);
  React.useEffect(() => {
    const stops = [subscribeRuntimeEndpointChanged(recheck), subscribeRuntimeAuthGenerationChanged(recheck)];
    return () => { for (const stop of stops) stop(); };
  }, []);
  const subscribe = React.useCallback((listener: () => void) => directory
    ? getSyncChildStores().getChild(directory)?.subscribe(listener) ?? (() => {}) : () => {}, [directory]);
  const snapshot = React.useCallback(() => sessionID && directory ? rowKey(getSyncSessions(directory).find(row => row.id === sessionID)) : '', [sessionID, directory]);
  const key = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const wasConnected = React.useRef(connected);
  React.useEffect(() => {
    if (connected && !wasConnected.current) recheck();
    wasConnected.current = connected;
  }, [connected]);
  React.useEffect(() => {
    if (!sessionID || !directory) return;
    const loader = getImperativeSessionMessageLoader();
    const target = { sessionID, directory };
    let previous = loader?.getSnapshot(target).status;
    return loader?.subscribe(target, () => {
      const next = loader.getSnapshot(target).status;
      if (next === 'ready' && previous !== 'ready' && !hasActiveSelectedOwnerOperation()) recheck();
      previous = next;
    });
  }, [sessionID, directory]);
  React.useEffect(() => {
    if (!sessionID || !directory || catalogStatus !== 'ready') return;
    const owner = readSelectedSessionOwner(sessionID, directory);
    const recovery = attemptedRevision.current !== runtimeRevision;
    attemptedRevision.current = runtimeRevision;
    if (owner?.status === 'checking' && !(proof && isSelectedOwnerCurrent(proof)) || owner?.status === 'unknown' && recovery)
      void checkSelectedSessionOwner(sessionID, directory);
  }, [sessionID, directory, key, global, catalog, catalogStatus, runtimeRevision, historyReadOnly, proof]);
  return readSelectedSessionOwner(sessionID, directory);
}
