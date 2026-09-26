import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { deferSettingsWritesUntilLoaded, invalidateSettingsCache, syncDesktopSettings } from './persistence';

// Run in its own process (CI's isolated runner): persistence's lifecycle binds to this test's Window.
// smarty-code#117: the draft-starters migration wrote its markers (and an unchanged list) on every first load. It
// now writes once, and only when it really changes a stored list; a load after that writes nothing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test('the starters migration writes only a list it changes, once; no list or a current one writes nothing', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let stored: SettingsPayload = {} as SettingsPayload;
  const saves: Array<Partial<SettingsPayload>> = [];
  registerRuntimeAPIs({ runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load: async () => ({ settings: structuredClone(stored), source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => { saves.push(changes); stored = { ...stored, ...changes }; return stored; } },
  } as unknown as RuntimeAPIs);
  const load = async () => { invalidateSettingsCache(); deferSettingsWritesUntilLoaded(); await syncDesktopSettings({ bootstrap: true }); await settle(); };
  try {
    await load(); // No stored list, no markers: the built-in default already has both starters.
    expect(saves).toEqual([]);
    stored = { draftStarters: [{ type: 'command', name: 'plan-feature' }, { type: 'command', name: 'craft-goal' },
      { type: 'command', name: 'schedule-task' }] } as SettingsPayload;
    await load(); // A stored list that already has both, without markers: nothing to change.
    expect(saves).toEqual([]);
    stored = { draftStarters: [{ type: 'command', name: 'plan-feature' }] } as SettingsPayload;
    await load(); // A legacy list without them: migrated once.
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      draftStarters: [{ type: 'command', name: 'plan-feature' }, { type: 'command', name: 'craft-goal' }, { type: 'command', name: 'schedule-task' }] });
    await load(); // The stored value is current now: a later load writes nothing.
    expect(saves).toHaveLength(1);
  } finally {
    registerRuntimeAPIs(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
