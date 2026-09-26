import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { NewSessionDraftState } from '@/sync/session-ui-store';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Operation refresh is covered elsewhere; this test isolates the capability check.
mock.module('@/sync/native-draft-control', () => ({ refreshNativeCreation: async () => {}, replyNativeCreation: async () => {},
  resumeNativeCreation: async () => {}, abandonNativeCreation: async () => false, abandonedNativeCreations: new Set<string>() }));
const { useNativeCreation } = await import('./useNativeCreation');

// smarty-code#113 / #126: before managed discovery answers, the directory may not be admitted (gateway 403), so no
// check is sent; once the catalog is ready the check runs, instead of staying on "Cannot check native creation support".
test('native creation support is checked once the managed catalog becomes ready, not before', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const client = opencodeClient as unknown as Record<string, unknown>;
  const original = { support: client.nativeCreationSupport, list: client.listNativeCreations };
  let admitted = false, checks = 0;
  client.nativeCreationSupport = async () => { checks++; if (!admitted) throw new Error('403 not admitted');
    return { mode: 'interactive', clientRequestId: true, abandon: false }; };
  client.listNativeCreations = async () => [];
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.setState({ projects: [], managedCatalogStatus: 'unknown' });
  const draft = { open: true, draftId: 1, target: 'project', directoryOverride: '/projects/owned',
    selectedProjectId: 'owned' } as unknown as NewSessionDraftState;
  let mode = '';
  const Probe = () => { mode = useNativeCreation(draft, null, undefined, getRuntimeKey()).mode; return null; };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect([mode, checks]).toEqual(['discovering', 0]); // "Loading projects…" (G13), never a home-directory check.
    // A first discovery that failed and is retrying is still "discovering": no check against the home fallback (G13).
    await act(async () => useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect([mode, checks]).toEqual(['discovering', 0]);
    admitted = true;
    await act(async () => useProjectsStore.getState().applyManagedCatalog([{ id: 'gateway-owned', worktree: '/projects/owned' }]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(checks).toBe(1);
    expect(mode).toBe('ordinary');
    // Unavailable AFTER discovery answered keeps the last-known projects: the composer is not sent back to discovering.
    await act(async () => useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(mode).not.toBe('discovering');
  } finally {
    await act(async () => root.unmount());
    client.nativeCreationSupport = original.support; client.listNativeCreations = original.list;
    useProjectsStore.getState().resetManagedCatalog();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});

test('discoveryPendingFor: unknown, or unavailable before any answer; never after an answer (G13)', async () => {
  const { discoveryPendingFor } = await import('./useNativeCreation');
  expect(discoveryPendingFor('unknown', false)).toBe(true);
  expect(discoveryPendingFor('unavailable', false)).toBe(true);
  expect(discoveryPendingFor('unavailable', true)).toBe(false);
  expect(discoveryPendingFor('ready', true)).toBe(false);
  expect(discoveryPendingFor('stock', true)).toBe(false);
});

test('discovery counts as answered after a stock answer too, even when a later refresh is unavailable (G13)', async () => {
  const { discoveryAnswered } = await import('@/lib/managed-discovery');
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: true, managedRows: null })).toBe(true);
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: false, managedRows: [] })).toBe(true);
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: false, managedRows: null })).toBe(false);
});
