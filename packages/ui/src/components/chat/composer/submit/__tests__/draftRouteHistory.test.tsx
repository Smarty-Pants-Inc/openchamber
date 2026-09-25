import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import * as managedRefresh from '@/lib/managed-project-refresh';
import * as globalSessions from '@/stores/useGlobalSessionsStore';
import { useRouter } from '@/hooks/useRouter';
import { readLastActiveSession } from '@/sync/last-session-cache';

// smarty-code#113 (OC#213 review): a draft action cancels a pending session restore at once, address bar included, so
// a reload before the restore settles shows the draft; leaving a shown session keeps its history entry.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let root: Root | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; await mounted?.dispose(); mounted = undefined; });
function Router() { useRouter(); return null; }
const settle = () => sleep(0);
const shown = () => new URL(window.location.href).searchParams.get('session');
const mountRouter = async (c: NonNullable<typeof mounted>) => {
  const host = document.createElement('div'); c.dom.container.appendChild(host);
  root = createRoot(host); root.render(<Router />); await settle();
};

for (const action of ['explicit', 'typed'] as const) test(`a draft action while a session restore is pending drops its ?session= at once: ${action}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const held = deferred<void>();
  const refresh = spyOn(managedRefresh, 'refreshManagedProjects').mockImplementation(() => held.promise);
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    expect(shown()).toBe(session.id);
    await act(async () => {
      if (action === 'explicit') useSessionUIStore.getState().openNewSessionDraft();
      else await c.replace('Unsent draft');
      await settle();
    });
    // Still pending: a reload now must not find the session anywhere.
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
  } finally { held.resolve(); refresh.mockRestore(); }
});

test('leaving a shown session for New session keeps its history entry: Back returns to it', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const other = { ...session, id: '98765432-1234-4234-9234-012345678901' };
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
    useGlobalSessionsStore.getState().applySnapshot([session, other], [], 'ready');
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
    window.history.replaceState(null, '', '/');
    await mountRouter(c);
  });
  const entries: (string | null)[] = [];
  const push = spyOn(window.history, 'pushState');
  try {
    for (const id of [session.id, other.id]) {
      await act(async () => { useSessionUIStore.getState().setCurrentSession(id, directory); await settle(); });
      entries.push(shown());
    }
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    expect(entries).toEqual([session.id, other.id]);
    expect(shown()).toBeNull();
    // The draft was pushed as its own entry, so the previous one (Back) is still the session just left.
    expect(push.mock.calls.map(call => String(call[2]))).toEqual([`/?session=${session.id}`, `/?session=${other.id}`, '/']);
  } finally { push.mockRestore(); }
});

test('a stock route restore that already shows its session, still loading: New session drops ?session= at once', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const held = deferred<void>();
  const load = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementation(async () => {
    await held.promise; return { activeSessions: [session], archivedSessions: [] };
  });
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id); // Shown before its snapshot arrives.
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => { held.resolve(); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull(); // The cancelled restore never reopens it.
    expect(shown()).toBeNull();
  } finally { held.resolve(); load.mockRestore(); }
});

test('a pending stock route for A, then B selected, then New session and typing: no ?session= survives a reload', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const other = { ...session, id: '98765432-1234-4234-9234-012345678901' };
  const held = deferred<void>();
  const load = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementation(async () => {
    await held.promise; return { activeSessions: [session, other], archivedSessions: [] };
  });
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    await act(async () => { useSessionUIStore.getState().setCurrentSession(other.id, directory); await settle(); });
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    await act(async () => { await c.replace('Unsent draft'); await settle(); });
    // A reload now finds no session in the address and no pointer: the draft is what comes back.
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => { held.resolve(); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(shown()).toBeNull();
  } finally { held.resolve(); load.mockRestore(); }
});
