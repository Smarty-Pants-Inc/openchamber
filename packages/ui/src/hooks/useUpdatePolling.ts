import React from 'react';

import { isElectronShell } from '@/lib/desktop';
import { useUpdateStore } from '@/stores/useUpdateStore';

/** Hourly native update check, Electron shell only. No other runtime checks for updates. */
export function useUpdatePolling() {
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const checkForUpdatesRef = React.useRef(checkForUpdates);

  React.useEffect(() => {
    checkForUpdatesRef.current = checkForUpdates;
  }, [checkForUpdates]);

  React.useEffect(() => {
    if (!isElectronShell()) return;
    const initialDelayMs = 3000;
    const intervalMs = 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const scheduleNext = (delayMs: number) => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        await checkForUpdatesRef.current();
        scheduleNext(intervalMs);
      }, delayMs);
    };

    scheduleNext(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);
}
