import type { ProjectEntry } from '@/lib/api/types';
import type { NewSessionDraftState } from './session-ui-store';

export type DraftProjectDirectory = {
  project: ProjectEntry | undefined;
  directory: string | null | undefined;
};

/** Resolve only the selected applied member; SDK fallback stays with the creation caller. */
export function resolveDraftProjectDirectory(
  draft: Pick<NewSessionDraftState, 'selectedProjectId' | 'directoryOverride'>,
  projects: readonly ProjectEntry[],
  policy: 'explicit' | 'project',
): DraftProjectDirectory {
  const project = projects.find(project => project.id === draft.selectedProjectId);
  if (policy === 'explicit') return { project, directory: draft.directoryOverride };
  // Prepared creation already reads the project path eagerly, even with an override.
  const projectDirectory = project?.path;
  return { project, directory: draft.directoryOverride ?? projectDirectory };
}

export type IdentityField =
  | { state: 'known'; value: string }
  | { state: 'none'; value: null }
  | { state: 'pending'; value: null };

type IdentityBase = {
  version: 1;
  runtimeKey: string;
  draftId: number;
  target: 'chat' | 'project';
  selectedProjectId: string | null;
  requestedDirectory: string | null;
  projectRoot: IdentityField;
  directory: IdentityField;
  nativeTarget: boolean;
};

export type NativeDraftIdentity = IdentityBase & (
  | { state: 'none'; reason: 'closed' | 'no-project' }
  | { state: 'resolved'; reason: null }
  | { state: 'pending'; reason: 'catalog-unanswered' | 'worktree-request'
      | 'worktree-catalog' | 'legacy-effect-directory' }
  | { state: 'inadmissible'; reason: 'selected-project-missing'
      | 'managed-directory-unadmitted' | 'native-needs-override' }
  | { state: 'unavailable'; reason: 'catalog-unavailable' | 'capability-unavailable' }
);
