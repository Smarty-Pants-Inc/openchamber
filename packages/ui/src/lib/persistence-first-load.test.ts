import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { startAppearanceAutoSave } from './appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from './directoryPersistence';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings, updateDesktopSettings } from './persistence';

// Run in its own process (CI's isolated runner): persistence's lifecycle binds to this test's Window.
// smarty-code#117 defect 1: a brand-new browser's first signed-in load PUT its startup values (splash colours,
// echoed and defaulted UI settings, a restored lastDirectory) over the settings another browser chose.
test("a fresh browser's first load adopts the shared settings and writes nothing; a later choice is saved", async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  // Browser A's shared choices, including values that differ from this browser's defaults.
  const shared = { useSystemTheme: true, themeId: 'openchamber-dark', themeVariant: 'dark', lightThemeId: 'openchamber-light',
    darkThemeId: 'openchamber-dark', splashBgLight: '#fdfcfa', splashFgLight: '#393a34', splashBgDark: '#120f0e',
    splashFgDark: '#c9c5ba', lastDirectory: '/repo/shared', showReasoningTraces: !useUIStore.getState().showReasoningTraces,
    mobileKeyboardMode: 'native', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true } as SettingsPayload;
  const saves: Array<Partial<SettingsPayload>> = [];
  registerRuntimeAPIs({ runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load: async () => ({ settings: { ...shared }, source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => { saves.push(changes); return { ...shared, ...changes } as SettingsPayload; } },
  } as unknown as RuntimeAPIs);
  invalidateSettingsCache();
  try {
    startAppearanceAutoSave();
    deferSettingsWritesUntilLoaded();
    // Before the load: this browser's theme effect publishes its derived defaults (theme and splash colours).
    const startup = updateDesktopSettings({ themeId: 'openchamber-light', themeVariant: 'light', useSystemTheme: true,
      lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark', splashBgLight: '#ffffff', splashFgLight: '#000000',
      splashBgDark: '#000000', splashFgDark: '#ffffff' });
    localStorage.setItem('lastDirectory', '/repo/other');
    await syncDesktopSettings({ bootstrap: true });
    await startup;
    await applyPersistedDirectoryPreferences();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(saves).toEqual([]);
    // An explicit choice in this browser is still saved, alone.
    useUIStore.getState().setShowReasoningTraces(!useUIStore.getState().showReasoningTraces);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(saves).toEqual([{ showReasoningTraces: !shared.showReasoningTraces }]);
  } finally {
    registerRuntimeAPIs(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
