export type PermissionAutoAcceptToggleArgs = {
    permissionScopeSessionId: string | null;
    newSessionDraftOpen: boolean;
    draftPermissionAutoAcceptEnabled: boolean;
    permissionAutoAcceptEnabled: boolean;
    setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

export const togglePermissionAutoAccept = (args: PermissionAutoAcceptToggleArgs): void => {
    // Compatibility entry point for older callers. Never mutate a draft or
    // policy, and never start a foreground reply loop on any runtime.
    args.onToggleFailed();
};
