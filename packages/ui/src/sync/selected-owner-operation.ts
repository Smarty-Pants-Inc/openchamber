import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { isHerdrEnded, isHerdrNoIdentity, isOrdinaryReloading, isPiDisconnected } from '@/lib/herdrSession';
import { assertRuntimeRequestScope, captureRuntimeRequestScope, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { subscribeRuntimeAuthGenerationChanged } from '@/lib/runtime-auth';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from './session-ui-store';
import { getDirectoryState, getSyncChildStores } from './sync-refs';
import { adoptObservedSessionOwner } from './session-actions';
import { getImperativeSessionMessageLoader } from './session-message-loader';
import { isSelectedOwnerCurrent, observation, readHerdrPaneLive, type SelectedManagedOwner } from './selected-session-owner';

const identitySchema = z.object({ id: z.string().min(1), directory: z.string().min(1) });
let selectionEpoch = 0;
let consumers = 0;
let unsubscribe: (() => void) | undefined;
let active: { controller: AbortController; adopting: boolean; promise?: Promise<void> } | undefined;
const cancelActive = () => active?.controller.abort(new Error('Selected owner read superseded'));
function releaseObservers() {
  if (consumers || active) return;
  unsubscribe?.();
  unsubscribe = undefined;
}
function observeSelection() {
  if (unsubscribe) return;
  const stops = [
    useSessionUIStore.subscribe((next, previous) => {
      if (next.currentSessionId === previous.currentSessionId && next.currentSessionDirectory === previous.currentSessionDirectory) return;
      selectionEpoch++;
      if (!active?.adopting) cancelActive();
    }),
    useProjectsStore.subscribe((next, previous) => {
      if (next.managedRows !== previous.managedRows || next.managedCatalogStatus !== previous.managedCatalogStatus
        || next.managedCatalogAdmitted !== previous.managedCatalogAdmitted) cancelActive();
    }),
    subscribeRuntimeAuthGenerationChanged(cancelActive),
    subscribeRuntimeEndpointWillChange(cancelActive),
    subscribeRuntimeEndpointChanged(cancelActive),
  ];
  unsubscribe = () => { for (const stop of stops) stop(); };
}
/** Mounted consumers share one selection lifetime. Last release is synchronous, including StrictMode cleanup. */
export function retainSelectedSessionOwner(): () => void {
  consumers++;
  observeSelection();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--consumers === 0) { selectionEpoch++; cancelActive(); }
    releaseObservers();
  };
}
// Read at call time; the operation owns the shared selection lifetime.
export function getSelectedOwnerSelectionEpoch(): number { return selectionEpoch; }
export function hasActiveSelectedOwnerOperation(): boolean { return Boolean(active); }

// Per-ID CAS, not an ordering of opaque native generations. Direct child writes are observations too.
function nativeSnapshot(sessionID: string, directory: string) {
  const state = getDirectoryState(directory);
  return { row: state?.session.find(row => row.id === sessionID),
    event: state?.sessionEventRevision?.[sessionID], deleted: state?.sessionDeletedRevision?.[sessionID] };
}
function sameNativeSnapshot(expected: ReturnType<typeof nativeSnapshot>, sessionID: string, directory: string) {
  const current = nativeSnapshot(sessionID, directory);
  return current.row === expected.row && current.event === expected.event && current.deleted === expected.deleted;
}

/** Explicit retry/direct checks own their observers until settlement; mounted checks share their lifetime and request. */
export function checkSelectedSessionOwner(sessionID: string, directory: string): Promise<void> {
  const existing = useSessionUIStore.getState().selectedManagedOwner;
  if (existing?.status === 'checking' && isSelectedOwnerCurrent(existing) && active?.promise && !active.controller.signal.aborted) return active.promise;
  const projects = useProjectsStore.getState();
  const catalog = projects.managedRows;
  const selection = useSessionUIStore.getState();
  if (!catalog || !projects.managedCatalogAdmitted || projects.managedCatalogStatus !== 'ready'
    || selection.currentSessionId !== sessionID || selection.currentSessionDirectory !== directory) return Promise.resolve();
  cancelActive();
  const operation: NonNullable<typeof active> = { controller: new AbortController(), adopting: false };
  active = operation;
  observeSelection();
  const scope = captureRuntimeRequestScope();
  const baselines = new Map(catalog.map(project => [project.worktree, nativeSnapshot(sessionID, project.worktree)]));
  let proof: SelectedManagedOwner = { status: 'checking', sessionID, directory, scope, catalog,
    observation: observation(sessionID, directory), selectionEpoch };
  useSessionUIStore.setState({ selectedManagedOwner: proof });
  const { controller } = operation;
  const timeout = setTimeout(() => controller.abort(new Error('Selected owner read timed out')), 10_000);
  const assertCurrent = () => {
    assertRuntimeRequestScope(scope);
    if (controller.signal.aborted || active !== operation || !isSelectedOwnerCurrent(proof) || useSessionUIStore.getState().selectedManagedOwner !== proof)
      throw new Error('Selected owner read superseded');
  };
  const stops = [useGlobalSessionsStore.subscribe(() => { if (!operation.adopting && !isSelectedOwnerCurrent(proof)) controller.abort(); })];
  const source = getSyncChildStores().getChild(directory);
  if (source) stops.push(source.subscribe(() => { if (!operation.adopting && !isSelectedOwnerCurrent(proof)) controller.abort(); }));
  const bound = <T,>(request: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    if (controller.signal.aborted) abort();
  });
  const run = (async () => {
    try {
      assertCurrent();
      // Runtime-only SDK does not insert currentDirectory. Strict all-admitted lookup, never lastGood.
      const result = await bound(opencodeClient.getSdkClient().session.get({ sessionID }, { signal: controller.signal }));
      assertCurrent();
      if (!result.response?.ok || result.response.headers.get('x-smarty-catalog-state') === 'stale' || !result.data)
        throw new Error('Strict selected owner detail unavailable (including missing/404)');
      const identity = identitySchema.parse(result.data);
      const initialNative = baselines.get(identity.directory);
      if (identity.id !== sessionID || !initialNative) throw new Error('Selected owner is outside current admitted catalog');
      let baseline = initialNative;
      const assertDestination = () => {
        if (!sameNativeSnapshot(baseline, sessionID, identity.directory)) throw new Error('Destination native observation changed');
      };
      assertDestination();
      const pane = readHerdrPaneLive(result.data);
      if (pane === false && isHerdrEnded(result.data)) {
        if (identity.directory !== directory) throw new Error('Ended owner directory differs from selected directory');
        proof = { ...proof, status: 'ended', row: result.data };
        useSessionUIStore.setState({ selectedManagedOwner: proof });
        return;
      }
      if (pane !== true || isHerdrEnded(result.data)) throw new Error('Detail has no live pane owner');
      const destination = getSyncChildStores().ensureChild(identity.directory, { bootstrap: false });
      // Creating our destination child may seed persisted history. Its initial snapshot is not a newer live event.
      baseline = nativeSnapshot(sessionID, identity.directory);
      if (identity.directory === directory) {
        proof = { ...proof, observation: observation(sessionID, directory) };
        useSessionUIStore.setState({ selectedManagedOwner: proof });
      }
      let acceptedNative = baseline;
      stops.push(destination.subscribe(() => {
        if (!operation.adopting && !sameNativeSnapshot(acceptedNative, sessionID, identity.directory)) controller.abort(new Error('Destination native observation changed'));
      }));
      const detail = await bound(opencodeClient.getScopedSdkClient(identity.directory).session.get({ sessionID }, { signal: controller.signal }));
      assertCurrent();
      assertDestination();
      if (!detail.response?.ok || detail.response.headers.get('x-smarty-catalog-state') === 'stale' || !detail.data || detail.data.id !== sessionID || detail.data.directory !== identity.directory
        || readHerdrPaneLive(detail.data) !== true || isHerdrEnded(detail.data) || isHerdrNoIdentity(detail.data)
        || isOrdinaryReloading(detail.data) || isPiDisconnected(detail.data) || !readOrdinaryModel(detail.data)?.model
        || readOrdinaryModel(result.data)?.generation !== readOrdinaryModel(detail.data)?.generation)
        throw new Error('Destination detail changed or is not writable');
      const loader = getImperativeSessionMessageLoader();
      if (!loader) throw new Error('Selected destination loader unavailable');
      // Synchronous CAS-to-adoption. Only this operation's own reconciliation may advance its selection fence.
      operation.adopting = true;
      try { adoptObservedSessionOwner(detail.data, directory); } finally { operation.adopting = false; }
      acceptedNative = nativeSnapshot(sessionID, identity.directory);
      proof = { ...proof, directory: identity.directory, adopted: true, observation: observation(sessionID, identity.directory), selectionEpoch };
      useSessionUIStore.setState({ selectedManagedOwner: proof });
      const target = { sessionID, directory: identity.directory };
      // Existing loader seam revokes stale accepted views and replaces its old credential-bound SDK.
      loader.configure({ sdk: opencodeClient.getSdkClient(), runtimeKey: scope.runtimeKey });
      await bound(loader.ensure(target, { force: true, reason: 'navigation' }));
      assertCurrent();
      if (!sameNativeSnapshot(acceptedNative, sessionID, identity.directory) || loader !== getImperativeSessionMessageLoader())
        throw new Error('Destination native observation or loader changed');
      const view = loader.getSnapshot(target);
      if (!view.resolved || view.status !== 'ready' || view.readOnly !== false || !loader.getAcceptedOrdinaryView(target, scope.runtimeKey))
        throw new Error('Fresh destination history has no accepted writable view');
      proof = { ...proof, status: 'live', row: detail.data };
      useSessionUIStore.setState({ selectedManagedOwner: proof });
    } catch (error) {
      if (active === operation && useSessionUIStore.getState().selectedManagedOwner === proof && isSelectedOwnerCurrent(proof)) {
        proof = { ...proof, status: 'unknown', reason: error instanceof Error ? error.message : 'Selected owner unavailable' };
        useSessionUIStore.setState({ selectedManagedOwner: proof });
      }
    } finally {
      clearTimeout(timeout);
      for (const stop of stops) stop();
      if (active === operation) active = undefined;
      releaseObservers();
    }
  })();
  operation.promise = run;
  return run;
}
