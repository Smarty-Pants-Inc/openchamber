import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"

type Dependencies = {
  getPolicy: () => Record<string, boolean>
  getSessions: () => ReadonlyMap<string, Session>
  getSession: (sessionId: string, directory?: string) => Promise<Session>
  getKnownPendingPermissions?: (directory?: string) => PermissionRequest[]
  listPendingPermissions: (directory?: string) => Promise<PermissionRequest[]>
  getPermissionState: (sessionId: string, requestId: string, directory?: string) => Promise<"ok" | "resolved" | "unknown">
  reply: (sessionId: string, requestId: string, directory?: string) => Promise<void>
  wait: (delayMs: number) => Promise<void>
}

// Hard disable the actual foreground responder, not only the bridge toggle.
// Persisted policies, delayed events and reconnect/bootstrap callers stay inert.
export function createVSCodePermissionAutoAcceptRuntime(_dependencies?: Dependencies) {
  void _dependencies
  const processPermission = async (
    _permission: PermissionRequest,
    _directory?: string,
    _options?: { verifyPending?: boolean },
  ): Promise<boolean> => {
    void _permission; void _directory; void _options
    return false
  }
  const reconcilePending = async (_directory?: string): Promise<void> => { void _directory }
  return { processPermission, reconcilePending }
}

const runtime = createVSCodePermissionAutoAcceptRuntime()
export const processVSCodePermissionAutoAccept = (
  permission: PermissionRequest,
  directory?: string,
) => runtime.processPermission(permission, directory)
export const processVSCodeReconciledPermissionAutoAccept = (
  permission: PermissionRequest,
  directory?: string,
) => runtime.processPermission(permission, directory)
export const reconcileVSCodePendingPermissions = runtime.reconcilePending
