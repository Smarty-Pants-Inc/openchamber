import { afterAll, expect, spyOn, test } from 'bun:test';

// smarty-code#113 / #117: loading the app (resolving and synchronizing the home directory) writes no shared settings.
// The server knows its own home directory; only an explicit user choice writes the shared settings.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(Object.create(globalThis), {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
  location: { origin: 'http://synthetic.invalid', href: 'http://synthetic.invalid/', search: '' },
}) });
const settings = await import('@/lib/persistence');
const save = spyOn(settings, 'updateDesktopSettings').mockResolvedValue(undefined);
const { opencodeClient } = await import('@/lib/opencode/client');
const home = spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home/tester');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useDirectoryStore } = await import('./useDirectoryStore');
afterAll(() => {
  save.mockRestore(); home.mockRestore();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
});

test('resolving and synchronizing the home directory at load writes no shared settings', async () => {
  // A runtime change re-resolves the home directory, exactly as a page load does.
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `load-writes-${crypto.randomUUID()}` });
  for (let i = 0; i < 20 && useDirectoryStore.getState().homeDirectory !== '/home/tester'; i++) await new Promise(r => setTimeout(r, 5));
  useDirectoryStore.getState().synchronizeHomeDirectory('/home/tester');
  expect(useDirectoryStore.getState().homeDirectory).toBe('/home/tester');
  expect(save.mock.calls).toHaveLength(0);
});
