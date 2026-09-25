import { afterAll, expect, mock, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';

// OC#194 review: VS Code's settings adapter answers a failed bridge read with local defaults. Such a read is never a
// base for a write, so an explicit pick while the read fails cannot erase the stored preferences.
const bridge = { fail: true, saves: [] as unknown[], stored: { favoriteModels: [{ providerID: 'anthropic', modelID: 'stored-a' }] } };
mock.module('../../../vscode/webview/api/bridge', () => ({
  sendBridgeMessage: async (type: string, payload?: unknown) => {
    if (type === 'api:config/settings:get') { if (bridge.fail) throw new Error('bridge down'); return bridge.stored; }
    if (type === 'api:config/settings:save') { bridge.saves.push(payload); return { ...bridge.stored, ...(payload as object) }; }
    throw new Error(`unexpected ${type}`);
  },
}));
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterAll(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); });

const { createVSCodeSettingsAPI } = await import('../../../vscode/webview/api/settings');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { startModelPrefsAutoSave } = await import('./modelPrefsAutoSave');
const { useUIStore } = await import('@/stores/useUIStore');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a failed VS Code settings read writes nothing; a good read then saves the user list', async () => {
  registerRuntimeAPIs({ runtime: { platform: 'vscode', isDesktop: false, isVSCode: true }, settings: createVSCodeSettingsAPI() } as unknown as RuntimeAPIs);
  useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'stored-a' }], recentModels: [], recentEfforts: {}, recentAgents: [] });
  // modelPrefsAutoSave runs only in a browser; the timers it needs are the global ones.
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  const stop = startModelPrefsAutoSave();
  try {
    useUIStore.getState().toggleFavoriteModel('openai', 'new-b'); // explicit, while the bridge read fails
    await wait(1400);
    expect(bridge.saves).toEqual([]); // never the fallback's empty favourites over the stored ones
    bridge.fail = false;
    useUIStore.getState().toggleFavoriteModel('openai', 'new-c');
    await wait(1400);
    expect(bridge.saves).toEqual([{ favoriteModels: [{ providerID: 'openai', modelID: 'new-c' },
      { providerID: 'openai', modelID: 'new-b' }, { providerID: 'anthropic', modelID: 'stored-a' }] }]);
  } finally { stop(); }
});
