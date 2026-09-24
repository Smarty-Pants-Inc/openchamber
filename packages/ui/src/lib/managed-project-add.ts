import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { canAddProjects, useProjectsStore } from '@/stores/useProjectsStore';
import { refreshManagedProjects } from './managed-project-refresh';

/** An explicit Add while discovery is unresolved retries it (joining one in flight) and allows the
 * add only on an affirmative stock answer from the same runtime (#126 item 8). */
export async function resolveProjectAddAllowed(): Promise<boolean> {
  const state = useProjectsStore.getState();
  if (canAddProjects(state)) return true;
  if (state.managedCatalogAdmitted) return false;
  const scope = captureRuntimeRequestScope();
  await refreshManagedProjects();
  return isRuntimeRequestScopeCurrent(scope) && canAddProjects(useProjectsStore.getState());
}
