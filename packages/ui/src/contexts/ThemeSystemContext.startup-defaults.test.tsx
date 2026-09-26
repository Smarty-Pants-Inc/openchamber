import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { writeThemePreferencesForRuntime } from './theme-storage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useThemeSystem } from './useThemeSystem';

let setTheme: (id: string) => void = () => {};
const Capture = () => { setTheme = useThemeSystem().setTheme; return null; };

// Run in its own process (CI's isolated runner): persistence's lifecycle binds to this test's Window.
// smarty-code#117 (code-demo's pre-check): shared settings with NO theme fields yet (a new install, or a document from
// before the splash colours). Mounting published this browser's default or cached theme and splash colours over them,
// with no user action; the load's deferral keeps only keys the server holds. A first load in a fresh profile, and in a
// reopened browser (a cached choice in localStorage), now writes nothing; a user's choice is still saved.
for (const reopened of [false, true]) test(`${reopened ? 'a reopened browser' : 'a fresh profile'} publishes no theme on a first load where none is stored`, async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  // A reopened browser: its cached choice for this runtime (dark), from an earlier session.
  if (reopened) writeThemePreferencesForRuntime(getRuntimeKey(), { themeMode: 'dark', lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark' });
  const saves: Array<Partial<SettingsPayload>> = [];
  const shared = { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true } as SettingsPayload;
  registerRuntimeAPIs({ runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load: async () => ({ settings: { ...shared }, source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => { saves.push(changes); return { ...shared, ...changes } as SettingsPayload; } },
  } as unknown as RuntimeAPIs);
  invalidateSettingsCache();
  const root = createRoot(document.createElement('div'));
  try {
    deferSettingsWritesUntilLoaded();
    await act(async () => root.render(<React.StrictMode><ThemeSystemProvider><Capture /></ThemeSystemProvider></React.StrictMode>));
    await act(async () => { await syncDesktopSettings(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(saves).toEqual([]);
    await act(async () => { setTheme('openchamber-light'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ themeId: 'openchamber-light', useSystemTheme: false });
  } finally {
    await act(async () => root.unmount());
    registerRuntimeAPIs(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
