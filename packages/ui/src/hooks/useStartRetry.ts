import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';

const MAX_DELAY_MS = 16_000;

/**
 * Browser mobile layout (smarty-code#302): the event stream that also marks the app connected mounts only after the
 * first connection, so a start whose health probe failed under load stayed on "Unable to reach server" for good.
 * While `enabled` and the app has neither connected nor initialized, retry the start with backoff (1 s, 2 s, ... 16 s),
 * as the desktop app does. It never gives up: a person on a phone has no other way to recover.
 */
export function useStartRetry(enabled: boolean, epoch: unknown) {
  const isInitialized = useConfigStore(state => state.isInitialized);
  const isConnected = useConfigStore(state => state.isConnected);
  React.useEffect(() => {
    if (!enabled || isInitialized || isConnected) return;
    let active = true, attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = async () => {
      if (!active) return;
      const state = useConfigStore.getState();
      if (state.isInitialized || state.isConnected) return;
      attempt += 1;
      await state.initializeApp();
      if (active && !useConfigStore.getState().isInitialized) timer = setTimeout(retry, Math.min(1000 * 2 ** attempt, MAX_DELAY_MS));
    };
    timer = setTimeout(retry, 1000);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [enabled, epoch, isConnected, isInitialized]);
}
