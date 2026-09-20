import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:net';
import { Window } from 'happy-dom';
import { createServer } from 'vite';

// Actual store, client, SDK and persistence; intercept only the final fetch.
// This file runs in its own process through the existing isolated test runner.
test('unavailable home cannot create a selected or navigable empty directory', async t => {
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = () => { throw new Error('This offline test must not open a listener'); };
  const window = new Window({ url: 'http://127.0.0.1:40000' });
  const descriptors = new Map(['window', 'document', 'localStorage', 'CustomEvent', 'HTMLElement', 'navigator']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window, document: window.document,
    localStorage: window.localStorage, CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement, navigator: window.navigator })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const writes = [];
  // Keep the interceptor installed until this isolated process exits: production
  // persistence may still drain an already scheduled debounce after test cleanup.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!['GET', 'HEAD'].includes(request.method)) {
      writes.push(new URL(request.url).pathname);
    }
    // Controlled unavailable home, metadata, auth and settings. No network fallback.
    return Response.json({ error: 'Offline unavailable' }, { status: 401 });
  };
  const cacheDir = await mkdtemp(join(tmpdir(), 'oc-directory-test-'));
  let loader;
  t.after(async () => {
    await loader?.close();
    Server.prototype.listen = originalListen;
    await window.happyDOM.close();
    await rm(cacheDir, { recursive: true, force: true });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const ui = fileURLToPath(new URL('../', import.meta.url));
  loader = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir, appType: 'custom', define: { process: 'undefined' },
    resolve: { alias: { '@': ui } }, server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] } });
  const { switchRuntimeEndpoint } = await loader.ssrLoadModule(`${ui}/lib/runtime-switch.ts`);
  switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:40000', runtimeKey: 'directory-bootstrap-test' });
  const { useDirectoryStore } = await loader.ssrLoadModule(`${ui}/stores/useDirectoryStore.ts`);
  const { opencodeClient } = await loader.ssrLoadModule(`${ui}/lib/opencode/client.ts`);
  const { getDeferredSafeStorage } = await loader.ssrLoadModule(`${ui}/stores/utils/safeStorage.ts`);
  await useDirectoryStore.getState().goHome();
  const unresolved = useDirectoryStore.getState();
  assert.equal(unresolved.currentDirectory, '');
  assert.equal(unresolved.homeDirectory, '');
  assert.deepEqual(unresolved.directoryHistory, []);
  assert.equal(unresolved.historyIndex, -1);
  assert.equal(unresolved.isHomeReady, false);
  assert.equal(unresolved.hasPersistedDirectory, false);
  assert.equal(window.localStorage.getItem('lastDirectory'), null);
  assert.equal(opencodeClient.getDirectory(), undefined);
  assert.equal(writes.filter(path => path === '/api/config/settings').length, 0);

  useDirectoryStore.getState().setDirectory('/owned/main');
  const selected = useDirectoryStore.getState();
  useDirectoryStore.getState().goBack();
  assert.equal(useDirectoryStore.getState(), selected);
  assert.equal(opencodeClient.getDirectory(), '/owned/main');
  assert.deepEqual(selected.directoryHistory, ['/owned/main']);
  useDirectoryStore.getState().setDirectory('  ');
  assert.equal(useDirectoryStore.getState(), selected);
  assert.equal(getDeferredSafeStorage().getItem('lastDirectory'), '/owned/main');
});
