import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { discoveryAnswered, discoveryPendingFor } from '@/lib/managed-discovery';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getWorktreeBootstrapState, subscribeWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { useProjectsStore, visibleProjects } from '@/stores/useProjectsStore';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { isManagedProjectDirectory, isNativeDraftTarget } from '@/sync/native-draft-creation';
import { resolveDraftProjectDirectory, type IdentityField, type NativeDraftIdentity as IdentityRecord } from '@/sync/native-draft-identity';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { useNativeCreation } from '../state/useNativeCreation';

const none: IdentityField = { state: 'none', value: null };
const pending: IdentityField = { state: 'pending', value: null };
const field = (value: string | null | undefined): IdentityField =>
  value == null ? none : { state: 'known', value };

type Props = {
  observedCapability: {
    runtimeKey: string;
    directory: string | null;
    mode: ReturnType<typeof useNativeCreation>['mode'];
  };
};

/** The applied draft identity, not capability, readiness or permission to Send. */
export function NativeDraftIdentity({ observedCapability }: Props) {
  const draft = useSessionUIStore(state => state.newSessionDraft);
  const projects = useProjectsStore(visibleProjects);
  const managedProjects = useProjectsStore(state => state.managedProjects);
  const managedRows = useProjectsStore(state => state.managedRows);
  const managedCatalogAdmitted = useProjectsStore(state => state.managedCatalogAdmitted);
  const managedCatalogStatus = useProjectsStore(state => state.managedCatalogStatus);
  const managedCatalogStockConfirmed = useProjectsStore(state => state.managedCatalogStockConfirmed);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const bootstrapSnapshot = React.useCallback(() => draft.bootstrapPendingDirectory
    ? getWorktreeBootstrapState(draft.bootstrapPendingDirectory) : null, [draft.bootstrapPendingDirectory]);
  React.useSyncExternalStore(subscribeWorktreeBootstrapState, bootstrapSnapshot, bootstrapSnapshot);

  const resolved = resolveDraftProjectDirectory(draft, projects, 'explicit');
  const requestedDirectory = resolved.directory ?? null;
  const root = field(resolved.project?.path);
  const directory = field(requestedDirectory);
  const base: Omit<IdentityRecord, 'state' | 'reason'> = {
    version: 1, runtimeKey, draftId: draft.draftId, target: draft.target,
    selectedProjectId: draft.open && draft.target === 'project' ? draft.selectedProjectId ?? null : null,
    requestedDirectory, projectRoot: root, directory,
    nativeTarget: isNativeDraftTarget(draft),
  };
  const answered = discoveryAnswered({ managedCatalogStatus, managedCatalogStockConfirmed, managedRows });
  const unanswered = !isVSCodeRuntime(getRegisteredRuntimeAPIs())
    && (discoveryPendingFor(managedCatalogStatus, answered)
      || (managedCatalogAdmitted && managedCatalogStatus !== 'unavailable'
        && (managedRows === null || managedProjects === null)));
  const mode = observedCapability.runtimeKey === runtimeKey && observedCapability.directory === draft.directoryOverride
    ? observedCapability.mode : null;

  const record: IdentityRecord = (() => {
    if (!draft.open) return { ...base, projectRoot: none, directory: none, state: 'none', reason: 'closed' };
    if (unanswered) return { ...base, projectRoot: resolved.project ? root : pending, directory: pending,
      state: 'pending', reason: 'catalog-unanswered' };
    if (managedCatalogStatus === 'unavailable' || (managedCatalogAdmitted && managedCatalogStatus !== 'ready')) {
      return { ...base, projectRoot: resolved.project ? root : pending,
        state: 'unavailable', reason: 'catalog-unavailable' };
    }
    if (draft.target !== 'project' || !draft.selectedProjectId) return { ...base, projectRoot: none, directory: none,
      state: 'none', reason: 'no-project' };
    if (!resolved.project) return { ...base, projectRoot: none, state: 'inadmissible', reason: 'selected-project-missing' };
    if (draft.pendingWorktreeRequestId) return { ...base, directory: pending, state: 'pending', reason: 'worktree-request' };
    if (managedCatalogAdmitted && !isManagedProjectDirectory(managedRows, resolved.project.path, requestedDirectory)) {
      if (requestedDirectory && draft.bootstrapPendingDirectory === requestedDirectory) {
        return { ...base, state: 'pending', reason: 'worktree-catalog' };
      }
      return { ...base, state: 'inadmissible', reason: 'managed-directory-unadmitted' };
    }
    if (mode === 'unavailable' || mode === 'notAdmitted') {
      return { ...base, state: 'unavailable', reason: 'capability-unavailable' };
    }
    if (mode === 'ordinary') {
      if (!requestedDirectory) return { ...base, state: 'inadmissible', reason: 'native-needs-override' };
      return { ...base, state: 'resolved', reason: null };
    }
    // Legacy preparation can replace an inherited missing path only after its asynchronous probe.
    if (!requestedDirectory
      || (draft.bootstrapPendingDirectory && draft.bootstrapPendingDirectory !== requestedDirectory)
      || (!draft.preserveDirectoryOverride && draft.bootstrapPendingDirectory !== requestedDirectory)) {
      return { ...base, directory: pending, state: 'pending', reason: 'legacy-effect-directory' };
    }
    return { ...base, state: 'resolved', reason: null };
  })();

  return <span hidden data-testid="native-draft-identity" data-draft-identity={JSON.stringify(record)} />;
}
