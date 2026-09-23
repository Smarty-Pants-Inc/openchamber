import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';
import { getDefaultTheme } from '@/lib/theme/themes';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';

let setTheme: (id: string) => void = () => {};
const Capture = () => { setTheme = useThemeSystem().setTheme; return null; };

// smarty-code#117: a fresh browser whose OS prefers light must not publish its derived
// light theme over a shared "system" choice made by another browser (seen live at 20:45:43Z).
test('a fresh browser does not publish its local theme over shared settings after the first load', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const saves: Array<Partial<SettingsPayload>> = [];
  const shared = { useSystemTheme: true, themeId: 'openchamber-dark', themeVariant: 'dark', lightThemeId: 'openchamber-light',
    darkThemeId: 'openchamber-dark', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true } as SettingsPayload;
  registerRuntimeAPIs({ runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load: async () => ({ settings: { ...shared }, source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => { saves.push(changes); return { ...shared, ...changes } as SettingsPayload; } },
  } as unknown as RuntimeAPIs);
  invalidateSettingsCache();
  const root = createRoot(document.createElement('div'));
  try {
    deferSettingsWritesUntilLoaded();
    await act(async () => root.render(<ThemeSystemProvider><Capture /></ThemeSystemProvider>));
    await act(async () => { await syncDesktopSettings(); });
    // Later theme-list churn (custom themes arriving) re-runs the theme effect with the same preferences.
    const extra = { ...getDefaultTheme(false), metadata: { ...getDefaultTheme(false).metadata, id: 'fixture-extra', name: 'Fixture extra' } };
    await act(async () => { window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: extra })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    const themeKeys = ['themeId', 'themeVariant', 'useSystemTheme', 'lightThemeId', 'darkThemeId'] as const;
    const overwrites = saves.filter((changes) => themeKeys.some((key) => key in changes && changes[key] !== shared[key]));
    expect(overwrites).toEqual([]);
    // An explicit user choice in this browser is still saved to the shared settings.
    await act(async () => { setTheme('openchamber-light'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(saves.at(-1)).toMatchObject({ themeId: 'openchamber-light', themeVariant: 'light', useSystemTheme: false });
  } finally {
    await act(async () => root.unmount());
    registerRuntimeAPIs(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
