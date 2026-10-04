import { create } from "zustand";
import type { PermissionAutoAcceptMap } from "./utils/permissionAutoAccept";

type PermissionPolicySnapshot = {
    sessions: PermissionAutoAcceptMap;
    revision?: number;
};

interface PermissionStore {
    autoAccept: PermissionAutoAcceptMap;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    legacyCandidate: PermissionAutoAcceptMap | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedRuntimeKey?: string) => void;
    reset: () => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

// Hard-disabled on every runtime. Do not attach persistence: neither startup nor
// reset/hydration may migrate, overwrite or clear an old permission-store record.
// Keep the former state/action contract for passive and older callers only.
export const usePermissionStore = create<PermissionStore>()((set) => ({
    autoAccept: {},
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,
    legacyCandidate: null,
    legacyRuntimeKey: null,
    hydrate: async () => { set({ loaded: true }); },
    applySnapshot: () => {},
    reset: () => { set({ autoAccept: {}, loaded: false, saving: false, lastAppliedRevision: -1 }); },
    isSessionAutoAccepting: () => false,
    setSessionAutoAccept: async (_sessionId, enabled) => {
        // Keep explicit Off a no-op for older callers. Enabling is unsupported
        // and never reaches transport; BTW sends no longer enroll any policy.
        if (enabled) throw new Error("Permission auto-accept is unsupported in this fork");
    },
}));
