import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import {
  getGitIdentities,
  getGlobalGitIdentity
} from "@/lib/gitApi";
import { updateDesktopSettings } from "@/lib/persistence";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { runtimeFetch } from "@/lib/runtime-fetch";

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  signCommits?: boolean;
  signingKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

interface GitIdentitiesStore {

  selectedProfileId: string | null;
  defaultGitIdentityId: string | null; // null = unset, 'global' = system, profile id = custom
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null;
  isLoading: boolean;

  setSelectedProfile: (id: string | null) => void;
  loadProfiles: () => Promise<boolean>;
  loadGlobalIdentity: () => Promise<boolean>;
  loadDefaultGitIdentityId: () => Promise<boolean>;
  setDefaultGitIdentityId: (id: string | null) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_git_identities_store__?: UseBoundStore<StoreApi<GitIdentitiesStore>>;
  }
}

export const useGitIdentitiesStore = create<GitIdentitiesStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedProfileId: null,
        defaultGitIdentityId: null,
        profiles: [],
        globalIdentity: null,
        isLoading: false,

        setSelectedProfile: (id: string | null) => {
          set({ selectedProfileId: id });
        },

        loadProfiles: async () => {
          set({ isLoading: true });
          const previousProfiles = get().profiles;

          try {
            const profiles = await getGitIdentities();
            set({ profiles, isLoading: false });
            return true;
          } catch (error) {
            console.error("Failed to load git identity profiles:", error);
            set({ profiles: previousProfiles, isLoading: false });
            return false;
          }
        },

        loadGlobalIdentity: async () => {
          try {
            const data = await getGlobalGitIdentity();

            if (data && data.userName && data.userEmail) {
              const globalProfile: GitIdentityProfile = {
                id: 'global',
                name: 'Global Identity',
                userName: data.userName,
                userEmail: data.userEmail,
                authType: data.sshCommand ? 'ssh' : undefined,
                sshKey: data.sshCommand ? data.sshCommand.replace('ssh -i ', '') : null,
                color: 'info',
                icon: 'fingerprint'
              };
              set({ globalIdentity: globalProfile });
            } else {
              set({ globalIdentity: null });
            }

            return true;
          } catch (error) {
            console.error("Failed to load global git identity:", error);
            set({ globalIdentity: null });
            return false;
          }
        },

        loadDefaultGitIdentityId: async () => {
          const normalize = (value: unknown): string | null => {
            if (typeof value !== 'string') {
              return null;
            }
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
          };

          try {
            let defaultId: string | null = null;

            if (defaultId === null) {
              const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
              if (runtimeSettings) {
                try {
                  const result = await runtimeSettings.load();
                  const settings = (result?.settings || {}) as Record<string, unknown>;
                  defaultId = normalize(settings.defaultGitIdentityId);
                } catch {
                  // fall through
                }
              }
            }

            if (defaultId === null) {
              try {
                const response = await runtimeFetch('/api/config/settings', {
                  method: 'GET',
                  headers: { Accept: 'application/json' },
                });
                if (response.ok) {
                  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
                  defaultId = normalize(data?.defaultGitIdentityId);
                }
              } catch {
                // ignore
              }
            }

            set({ defaultGitIdentityId: defaultId });
            return true;
          } catch (error) {
            console.error('Failed to load default git identity setting:', error);
            return false;
          }
        },

        setDefaultGitIdentityId: async (id) => {
          try {
            const trimmed = typeof id === 'string' ? id.trim() : '';
            const value = trimmed.length > 0 ? trimmed : '';
            await updateDesktopSettings({ defaultGitIdentityId: value });
            set({ defaultGitIdentityId: value.length > 0 ? value : null });
            return true;
          } catch (error) {
            console.error('Failed to save default git identity setting:', error);
            return false;
          }
        },
      }),
      {
        name: "git-identities-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedProfileId: state.selectedProfileId,
        }),
      },
    ),
    {
      name: "git-identities-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_git_identities_store__ = useGitIdentitiesStore;
}
