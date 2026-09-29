import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import type { useSyncRuntime } from '@/sync/sync-context';

mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }), preloadProviderLogos: () => undefined }));
const { ChatContainer } = await import('@/components/chat/ChatContainer');

// smarty-code#775 case (2), #761: a worktree removed while its session opens. Its history read fails with no status;
// the transcript said "the server may be offline". A directory that left the catalog now reads as gone. A genuine
// network failure, and an open whose project has not joined yet (#608), keep their own words.
const GONE = 'This session is no longer available: its Pi ended or its worktree was removed.';
const OFFLINE = 'the server may be offline';
type RuntimeValue = ReturnType<typeof useSyncRuntime>;
const globals = globalThis as typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(RuntimeValue & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<RuntimeValue | null>;
};
const System = globals.__openchamber_sync_context__, Runtime = globals.__openchamber_sync_runtime_context__;
function parent(fixture: Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[3]>>[0]) {
  if (!System || !Runtime) throw new Error('Actual sync context seam unavailable');
  const runtime: RuntimeValue = { childStores: fixture.children, messageLoader: fixture.loader,
    sdk: opencodeClient.getSdkClient(), runtimeKey: fixture.runtimeA,
    currentDirectory: { get: () => directory, subscribe: () => () => undefined } };
  return <System.Provider value={{ ...runtime, directory }}><Runtime.Provider value={runtime}>
    <ChatContainer messagesEnabled />
  </Runtime.Provider></System.Provider>;
}
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

/** Opens the session while its history read is held, applies `during`, then fails the read with no HTTP status. */
async function openWhileReadFails(admitted: boolean, during: () => void) {
  let fail!: () => void, reading = false;
  const held = new Promise<never>((_, reject) => { fail = () => reject(new TypeError('Failed to fetch')); });
  held.catch(() => undefined); // Unread when the open waits for its project.
  const c = mounted = await mountedNativeComposer(true, undefined, undefined, parent, () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.getState().admitManagedCatalog();
    useProjectsStore.getState().applyManagedCatalog(admitted ? [{ id: 'gateway-a', worktree: directory }] : []);
  });
  c.handlers.history = () => { reading = true; return held; };
  await act(async () => { useSessionUIStore.getState().setCurrentSession(session.id, directory); await sleep(0); });
  for (let i = 0; i < 50 && !reading; i++) await act(() => sleep(10));
  expect(reading).toBe(admitted); // In flight (an open whose project has not joined waits for it, #608).
  await act(async () => { during(); await sleep(0); });
  await act(async () => { fail(); await sleep(0); await sleep(0); });
  for (let i = 0; i < 100 && !/could not|no longer/.test(c.dom.container.textContent ?? ''); i++) await act(() => sleep(20));
  const text = c.dom.container.textContent ?? ""; return text;
}

test('the worktree leaves the catalog while its session\'s history is read, the read fails with no status: gone, not offline', async () => {
  const text = await openWhileReadFails(true, () => useProjectsStore.getState().applyManagedCatalog([]));
  expect(text).toContain(GONE);
  expect(text).not.toContain(OFFLINE);
  expect(text).not.toContain('Waiting for this project'); // Not loading: gone.
}, 20_000);

test('counterexample: the worktree is still listed and the read fails with no status: the offline words stay', async () => {
  const text = await openWhileReadFails(true, () => undefined);
  expect(text).toContain(OFFLINE);
  expect(text).not.toContain(GONE);
}, 20_000);

test('counterexample: an open whose project has not joined the catalog yet (#608) is not called gone', async () => {
  const text = await openWhileReadFails(false, () => useProjectsStore.getState().applyManagedCatalog([]));
  expect(useProjectsStore.getState().departedDirectories).toEqual([]);
  expect(text).not.toContain(GONE);
  expect(text).toContain('Waiting for this project'); // #608's own words stay.
}, 20_000);
