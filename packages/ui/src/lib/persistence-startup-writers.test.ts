import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { startAppearanceAutoSave } from './appearanceAutoSave';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings } from './persistence';

// Run in its own process (CI's isolated runner): persistence's lifecycle binds to this test's Window.
// smarty-code#117 (code-demo's pre-check): startup writers of shared settings with no user action. Here: the
// persistence.ts migration and seed patches, and the followUpBehavior echo. A shared settings document that has none
// of the newer keys (no starter markers, no sidebar modes, no autoSaveEnabled) and only the legacy queueModeEnabled.
const shared = { queueModeEnabled: false } as SettingsPayload;
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test('a first load in a fresh profile, and again in a reopened browser, writes no shared settings', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const saves: Array<Partial<SettingsPayload>> = [];
  registerRuntimeAPIs({ runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load: async () => ({ settings: { ...shared }, source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => { saves.push(changes); return { ...shared, ...changes } as SettingsPayload; } },
  } as unknown as RuntimeAPIs);
  try {
    startAppearanceAutoSave();
    // Fresh profile: the stores hold their defaults.
    invalidateSettingsCache();
    deferSettingsWritesUntilLoaded();
    await syncDesktopSettings({ bootstrap: true });
    await settle();
    expect(saves).toEqual([]);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer'); // Legacy queueModeEnabled: false, in memory.

    // Reopened browser: this browser's own earlier preferences, which the shared document does not hold.
    const ui = useUIStore.getInitialState(), display = useSessionDisplayStore.getInitialState();
    useUIStore.setState({ autoSaveEnabled: !ui.autoSaveEnabled });
    useSessionDisplayStore.setState({ projectDisplayMode: display.projectDisplayMode === 'all' ? 'single' : 'all',
      showRecentSection: !display.showRecentSection });
    invalidateSettingsCache();
    deferSettingsWritesUntilLoaded();
    await syncDesktopSettings({ bootstrap: true });
    await settle();
    expect(saves).toEqual([]);
    expect(useUIStore.getState().autoSaveEnabled).toBe(!ui.autoSaveEnabled); // Kept for this browser, not published.

    // A user's own choice is still saved, alone.
    useMessageQueueStore.getState().setFollowUpBehavior('queue');
    await settle();
    expect(saves).toEqual([{ followUpBehavior: 'queue' }]);
  } finally {
    registerRuntimeAPIs(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
