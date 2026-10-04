// UNRUN on baseline: isolated view-added IO requires the owner's new component.
import '@/sync/native-test-network';
import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { nativeComposerDom } from './nativeComposer-dom';
import { expectIdentity, known, none, pending } from './nativeDraftIdentity-record.test';
import { nativeDraftFixture, directory, draft } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { useConfigStore } from '@/stores/useConfigStore';
import * as bootstrap from '@/lib/worktrees/worktreeBootstrap';

async function isolated() {
  const dom = nativeComposerDom(), f = nativeDraftFixture();
  // Settle the real endpoint startup before dynamic imports or measurement.
  await expect(refreshRuntimeUrlAuthToken()).rejects.toThrow('Failed to mint runtime URL auth token (404)');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].method).toBe('POST');
  expect(new URL(f.requests[0].url).pathname).toBe('/auth/url-token');
  const { createRoot } = await import('react-dom/client');
  const { NativeDraftIdentity } = await import('@/components/chat/composer/ui/NativeDraftIdentity');
  // Join the actual directory startup owner after imports, as the mounted fixture does.
  await useConfigStore.getState().activateDirectory(directory);
  const before = f.requests.length;
  const root = createRoot(dom.container);
  const render = async (mode: 'ordinary' | 'legacy' | 'unavailable' | 'loading' = 'ordinary', runtimeKey = f.runtimeA) => {
    await act(async () => root.render(<NativeDraftIdentity observedCapability={{ runtimeKey,
      directory: useSessionUIStore.getState().newSessionDraft.directoryOverride ?? null, mode }} />));
  };
  return { ...f, before, dom, render, unmount: async () => { await act(async () => root.unmount()); }, close: async () => { await act(async () => root.unmount()); f.dispose(); await dom.restore(); } };
}

test('isolated identity mount, repeated reads, rerender and unmount add ZERO IO and writes', async () => {
  const c = await isolated();
  const support = spyOn(opencodeClient, 'nativeCreationSupport'), health = spyOn(opencodeClient, 'supportsNativeCreation');
  const storage = spyOn(c.dom.window.localStorage, 'setItem');
  const watcher = spyOn(bootstrap, 'startWorktreeBootstrapWatcher'), child = spyOn(c.children, 'ensureChild');
  let writes = 0;
  const stores = [useSessionUIStore, useInputStore, useProjectsStore, useDirectoryStore, useGlobalSessionsStore];
  const snapshots = stores.map(store => store.getState());
  const stops = stores.map(store => store.subscribe(() => writes++));
  const before = c.requests.length;
  try {
    await c.render();
    for (let i = 0; i < 10; i++) expectIdentity(c.dom.container, { state: 'resolved', reason: null,
      projectRoot: known(directory), directory: known(directory), nativeTarget: true });
    await c.render(); await c.unmount();
    expect(watcher).not.toHaveBeenCalled(); expect(child).not.toHaveBeenCalled();
    expect(c.requests).toHaveLength(before); expect(writes).toBe(0); expect(storage).not.toHaveBeenCalled();
    expect(support).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled();
    stores.forEach((store, i) => expect(store.getState()).toBe(snapshots[i]));
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
  } finally {
    for (const stop of stops) stop(); storage.mockRestore(); watcher.mockRestore(); child.mockRestore(); support.mockRestore(); health.mockRestore(); await c.close();
  }
});

for (const override of [null, '']) test(`ordinary explicit override ${JSON.stringify(override)} is not fallback project directory`, async () => {
  const c = await isolated();
  try {
    useSessionUIStore.setState({ newSessionDraft: { ...draft, directoryOverride: override } }); await c.render();
    expectIdentity(c.dom.container, { state: 'inadmissible', reason: 'native-needs-override',
      projectRoot: known(directory), directory: override === null ? none : known(''), nativeTarget: false });
    expect(c.requests).toHaveLength(c.before);
  } finally { await c.close(); }
});

for (const preserve of [false, true]) test(`legacy future directory uncertainty; preserve ${preserve}`, async () => {
  const c = await isolated();
  try {
    useSessionUIStore.setState({ newSessionDraft: { ...draft, preserveDirectoryOverride: preserve } }); await c.render('legacy');
    expectIdentity(c.dom.container, { state: preserve ? 'resolved' : 'pending', reason: preserve ? null : 'legacy-effect-directory',
      projectRoot: known(directory), directory: preserve ? known(directory) : pending, nativeTarget: true });
    expect(c.requests).toHaveLength(c.before);
  } finally { await c.close(); }
});

test('old-runtime capability observation cannot certify current runtime identity', async () => {
  const c = await isolated();
  try {
    await c.render('ordinary', 'detached-runtime');
    expectIdentity(c.dom.container, { state: 'pending', reason: 'legacy-effect-directory',
      projectRoot: known(directory), directory: pending, nativeTarget: true });
    await c.render();
    expectIdentity(c.dom.container, { state: 'resolved', reason: null,
      projectRoot: known(directory), directory: known(directory), nativeTarget: true });
    expect(c.requests).toHaveLength(c.before);
  } finally { await c.close(); }
});

for (const constraint of [{ title: 'explicit-title' }, { parentID: 'parent-session' }])
  test(`known identity is not native target admission ${JSON.stringify(constraint)}`, async () => {
    const c = await isolated();
    try {
      useSessionUIStore.setState({ newSessionDraft: { ...draft, ...constraint } }); await c.render();
      expectIdentity(c.dom.container, { state: 'resolved', reason: null,
        projectRoot: known(directory), directory: known(directory), nativeTarget: false });
      expect(c.requests).toHaveLength(c.before);
    } finally { await c.close(); }
  });

test('matching unavailable capability keeps chosen fields but never certifies resolved', async () => {
  const c = await isolated();
  try {
    await c.render('unavailable');
    expectIdentity(c.dom.container, { state: 'unavailable', reason: 'capability-unavailable',
      projectRoot: known(directory), directory: known(directory), nativeTarget: true });
    expect(c.requests).toHaveLength(c.before);
  } finally { await c.close(); }
});
