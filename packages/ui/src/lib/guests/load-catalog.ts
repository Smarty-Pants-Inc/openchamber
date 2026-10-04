import { getRuntimeKey } from '@/lib/runtime-switch';

import { useGuestBadgeStore } from './badge-store.ts';
import { useGuestsStore } from './store.ts';

const alignCatalogRuntime = (runtimeKey: string): void => {
  const store = useGuestsStore.getState();
  if (store.runtimeKey !== runtimeKey) {
    store.resetForRuntimeSwitch(runtimeKey);
    useGuestBadgeStore.getState().resetForRuntimeSwitch();
  }
};

/** Guests are hard-disabled in this fork, including external and relay runtimes (#1325). */
export const loadGuestCatalog = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  alignCatalogRuntime(runtimeKey);
  useGuestsStore.getState().markUnsupported(runtimeKey);
  return Promise.resolve();
};
