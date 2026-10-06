import { create } from 'zustand';
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import {
  checkForDesktopUpdates,
  downloadDesktopUpdate,
  restartToApplyUpdate,
  isElectronShell,
} from '@/lib/desktop';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { getUpdateInstallErrorMessage } from '@/lib/updateInstallError';

// Only the Electron shell updates itself, through its native updater. The
// served web, VS Code and mobile runtimes have no update check: the server's
// update-check/update-install routes were removed (smarty-code#1398).
type UpdateState = {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  lastChecked: number | null;
};

interface UpdateStore extends UpdateState {
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  dismiss: () => void;
  reset: () => void;
}

const initialState: UpdateState = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  info: null,
  progress: null,
  error: null,
  lastChecked: null,
};

export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  ...initialState,

  checkForUpdates: async () => {
    if (!isElectronShell()) return;

    set({ checking: true, error: null });

    try {
      const desktopInfo = await checkForDesktopUpdates();
      set({
        checking: false,
        available: desktopInfo?.available ?? false,
        info: desktopInfo,
        lastChecked: Date.now(),
      });
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  },

  downloadUpdate: async () => {
    if (!isElectronShell() || !get().available) {
      return;
    }

    set({ downloading: true, error: null, progress: null });

    try {
      const desktopInfo = await checkForDesktopUpdates();
      if (!desktopInfo?.available) {
        throw new Error('Update detected, but desktop package is not ready yet. Retry in a moment.');
      }

      set((state) => ({
        info: state.info
          ? {
            ...state.info,
            ...desktopInfo,
            body: state.info.body || desktopInfo.body,
            available: state.info.available,
          }
          : desktopInfo,
      }));

      const ok = await downloadDesktopUpdate((progress) => {
        set({ progress });
      });
      if (!ok) {
        throw new Error('Desktop update only works on Local instance');
      }
      set({ downloading: false, downloaded: true });
    } catch (error) {
      set({
        downloading: false,
        error: error instanceof Error ? error.message : 'Failed to download update',
      });
    }
  },

  restartToUpdate: async () => {
    if (!isElectronShell() || !get().downloaded) {
      return;
    }

    set({ error: null });

    try {
      const ok = await restartToApplyUpdate();
      if (!ok) {
        // No desktop bridge at all — the update was never installable here.
        throw new Error(formatMessage(useI18nStore.getState().dictionary, 'updateDialog.error.restartUnavailable'));
      }
    } catch (error) {
      // Keep the real installer failure; the dialog shows it and the button
      // stays clickable for another attempt.
      set({ error: getUpdateInstallErrorMessage(error instanceof Error ? error : new Error(String(error))) });
    }
  },

  dismiss: () => {
    set({ available: false, downloaded: false, info: null });
  },

  reset: () => {
    set(initialState);
  },
}));
