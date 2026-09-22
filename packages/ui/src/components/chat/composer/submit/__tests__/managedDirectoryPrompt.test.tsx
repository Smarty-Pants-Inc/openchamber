import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { sessionEvents } from '@/lib/sessionEvents';
import * as desktop from '@/lib/desktop';

// The actual owner decides when to open. Filesystem browsing is outside this check.
mock.module('@/components/session/DirectoryExplorerDialog', () => ({
  DirectoryExplorerDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <button data-testid="directory-prompt" onClick={() => onOpenChange(false)}>Close picker</button> : null,
}));
const { SessionDialogs } = await import('@/components/session/SessionDialogs');
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const prompt = () => mounted?.dom.container.querySelector('[data-testid="directory-prompt"]');

for (const outcome of ['member', 'empty', 'stock'] as const) test(`initial directory prompt waits for catalog resolution: ${outcome}`, async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, <SessionDialogs />);
  await act(async () => {
    useDirectoryStore.setState({ isHomeReady: true, homeDirectory: '/synthetic-home' });
    useProjectsStore.setState({ projects: [], activeProjectId: null, managedCatalogAdmitted: false,
      managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
    await sleep(0);
  });
  expect(Boolean(prompt())).toBe(false);
  if (outcome !== 'stock') {
    await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await sleep(0); });
    expect(Boolean(prompt())).toBe(false);
    await act(async () => { useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }); await sleep(0); });
    expect(Boolean(prompt())).toBe(false);
  }
  await act(async () => {
    if (outcome === 'stock') useProjectsStore.setState({ managedCatalogStatus: 'stock' });
    else useProjectsStore.getState().applyManagedCatalog(outcome === 'member' ? [{ id: 'a', worktree: '/native-project' }] : []);
    await sleep(0);
  });
  expect(Boolean(prompt())).toBe(outcome !== 'member');
  if (prompt()) await act(async () => { prompt()?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  // The initial-prompt gate never blocks an explicit user Add request, including while loading.
  await act(async () => {
    useProjectsStore.getState().resetManagedCatalog();
    sessionEvents.requestDirectoryDialog();
    await sleep(0);
  });
  expect(prompt()).not.toBeNull();
  expect(c.prompts()).toHaveLength(0);
});

test('unmanaged VS Code retains its initial empty prompt without catalog discovery', async () => {
  const vscode = spyOn(desktop, 'isVSCodeRuntime');
  vscode.mockReturnValue(true);
  try {
    mounted = await mountedNativeComposer(false, undefined, <SessionDialogs />);
    await act(async () => {
      useDirectoryStore.setState({ isHomeReady: true });
      useProjectsStore.setState({ projects: [], managedCatalogAdmitted: false, managedCatalogStatus: 'unknown' });
      await sleep(0);
    });
    expect(prompt()).not.toBeNull();
  } finally { vscode.mockRestore(); }
});
