import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SettingsPayload } from '@/lib/api/types';
import { createWebAPIs } from '../../../web/src/api';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { startAppearanceAutoSave } from './appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from './directoryPersistence';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings, updateDesktopSettings } from './persistence';

// Run in its own process (CI's isolated runner): persistence's lifecycle binds to this test's Window.
// smarty-code#117 defect 1: a brand-new browser's first signed-in load PUT its startup values
// (echoed and defaulted UI settings, a restored lastDirectory) over the settings another browser chose.
test("a fresh browser's first load adopts the shared settings and writes nothing; a later choice is saved", async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  // Browser A's shared choices, including values that differ from this browser's defaults.
  const shared = { useSystemTheme: true, themeId: 'openchamber-dark', themeVariant: 'dark', lightThemeId: 'openchamber-light',
    darkThemeId: 'openchamber-dark', lastDirectory: '/repo/shared', showReasoningTraces: !useUIStore.getState().showReasoningTraces,
    mobileKeyboardMode: 'native', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true } satisfies SettingsPayload;
  const saves: Array<Partial<SettingsPayload>> = [];
  const apis = createWebAPIs();
  apis.settings = { load: async () => ({ settings: { ...shared }, source: 'web' }),
    save: async (changes) => { saves.push(changes); return { ...shared, ...changes }; } };
  registerRuntimeAPIs(apis);
  invalidateSettingsCache();
  try {
    startAppearanceAutoSave();
    deferSettingsWritesUntilLoaded();
    // Splash colours belong to this browser, not the shared settings document.
    const splash = { splashBgLight: '#ffffff', splashFgLight: '#000000', splashBgDark: '#000000', splashFgDark: '#ffffff' };
    for (const [key, value] of Object.entries(splash)) localStorage.setItem(key, value);
    // Before the load: this browser publishes its derived per-surface theme defaults.
    const startup = updateDesktopSettings({ themeId: 'openchamber-light', themeVariant: 'light', useSystemTheme: true,
      lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark' });
    localStorage.setItem('lastDirectory', '/repo/other');
    await syncDesktopSettings({ bootstrap: true });
    await startup;
    await applyPersistedDirectoryPreferences();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(saves).toEqual([]);
    expect(useUIStore.getState().showReasoningTraces).toBe(shared.showReasoningTraces);
    for (const [key, value] of Object.entries(splash)) expect(localStorage.getItem(key)).toBe(value);
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
