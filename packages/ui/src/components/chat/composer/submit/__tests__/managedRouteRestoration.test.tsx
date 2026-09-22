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
import { useRouter } from '@/hooks/useRouter';
import { persistLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let root: Root | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; await mounted?.dispose(); mounted = undefined; });
function Router() { useRouter(); return null; }
const settle = () => sleep(0);

for (const admitted of [false, true]) for (const result of ['present', 'absent', 'unavailable', 'explicit', 'typed', 'runtime', 'wrong-directory'] as const) test(`session URL initialization (admitted ${admitted}): ${result}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const routed = result === 'wrong-directory' ? { ...session, id: '98765432-1234-4234-9234-012345678901' } : session;
  const held = deferred<void>();
  const refresh = spyOn(managedRefresh, 'refreshManagedProjects').mockImplementation(() => held.promise);
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: admitted, managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
      useGlobalSessionsStore.getState().applySnapshot([], [], 'ready');
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      if (result === 'wrong-directory') persistLastActiveSession(c.runtimeA, { sessionId: routed.id, directory: '/wrong-directory' });
      window.history.replaceState(null, '', `/?session=${routed.id}`);
      const host = document.createElement('div'); c.dom.container.appendChild(host);
      root = createRoot(host); root.render(<Router />);
      await settle();
    });
    expect(new URL(window.location.href).searchParams.get('session')).toBe(routed.id);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    if (!admitted) {
      await act(async () => { useProjectsStore.getState().admitManagedCatalog(); await settle(); });
      expect(new URL(window.location.href).searchParams.get('session')).toBe(routed.id);
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    }
    await act(async () => {
      if (result === 'explicit') useSessionUIStore.getState().openNewSessionDraft();
      if (result === 'typed') await c.replace('New route draft');
      if (result === 'runtime') c.switchRuntime('different-runtime');
      if (result === 'unavailable') useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
      else {
        useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
        useGlobalSessionsStore.getState().applyManagedSessions(result === 'absent' ? [] : [routed],
          useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
      }
      held.resolve(); await settle();
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(result === 'present' ? session.id : null);
    if (result === 'present') {
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
      expect(new URL(window.location.href).searchParams.get('session')).toBe(session.id);
    }
    if (result === 'absent' || result === 'explicit' || result === 'typed' || result === 'wrong-directory') {
      expect(readLastActiveSession(c.runtimeA)).toBeNull();
      expect(new URL(window.location.href).searchParams.get('session')).toBeNull();
    }
    if (result === 'unavailable') {
      expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
      expect(new URL(window.location.href).searchParams.get('session')).toBe(session.id);
      await act(async () => {
        useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
        useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
        await settle();
      });
      expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
    }
    expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  } finally { held.resolve(); refresh.mockRestore(); }
});
