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
import { readLastActiveSession } from '@/sync/last-session-cache';
import { opencodeClient } from '@/lib/opencode/client';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  await mounted?.dispose(); mounted = undefined;
});
function Router() { useRouter(); return null; }

for (const ordering of ['serialized', 'superseded', 'cancelled', 'runtime-switch'] as const)
  test(`route follows current discovery: ${ordering}`, async () => {
    const c = mounted = await mountedNativeComposer(true);
    const stock = () => ({ response: new Response('[]', { status: 200 }),
      request: new Request('http://synthetic.invalid/project'), data: [], error: undefined });
    const first = deferred<ReturnType<typeof stock>>(), second = deferred<ReturnType<typeof stock>>();
    let calls = 0, fresh: Promise<void> | undefined;
    const read = spyOn(opencodeClient.getSdkClient().project, 'list')
      .mockImplementation(() => ++calls === 1 ? first.promise : second.promise);
    try {
      await act(async () => {
        useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
        useGlobalSessionsStore.getState().applySnapshot([session], [], 'ready');
        useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
        await sleep(0);
      });
      await act(async () => {
        window.history.replaceState(null, '', `/?session=${session.id}`);
        const host = document.createElement('div'); c.dom.container.appendChild(host);
        root = createRoot(host); root.render(<Router />); await sleep(0);
      });
      expect(calls).toBe(1);
      if (ordering !== 'serialized') fresh = managedRefresh.refreshManagedProjects(true);
      await act(async () => { first.resolve(stock()); await sleep(0); });
      if (ordering === 'serialized') fresh = managedRefresh.refreshManagedProjects(true);
      else {
        expect(useProjectsStore.getState().managedCatalogStatus).toBe('unknown');
        expect(useSessionUIStore.getState().currentSessionId).toBeNull();
        expect(new URL(window.location.href).searchParams.get('session')).toBe(session.id);
      }
      await act(async () => {
        if (ordering === 'cancelled') useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: 'a', directoryOverride: directory }, { force: true });
        if (ordering === 'runtime-switch') c.switchRuntime(`${c.runtimeA}-next`);
        second.resolve(stock()); await fresh; await sleep(0);
      });
      const cancelled = ordering === 'cancelled' || ordering === 'runtime-switch';
      expect(calls).toBe(2);
      expect(useSessionUIStore.getState().currentSessionId).toBe(cancelled ? null : session.id);
      if (!cancelled) {
        expect(useProjectsStore.getState().managedCatalogStatus).toBe('stock');
        expect(useProjectsStore.getState().managedCatalogAdmitted).toBe(false);
        expect(useProjectsStore.getState().activeProjectId).toBe('a');
        expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
        expect(new URL(window.location.href).searchParams.get('session')).toBe(session.id);
        expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
      }
      expect(c.prompts()).toHaveLength(0);
    } finally {
      first.resolve(stock()); second.resolve(stock()); await fresh;
      await act(async () => root?.unmount()); root = undefined; read.mockRestore();
    }
  });

for (const target of [{ selectedProjectId: null, directoryOverride: directory },
  { selectedProjectId: 'a', directoryOverride: '/removed-worktree' }]) test(`actual draft fallback still repairs ${JSON.stringify(target)}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  await act(async () => {
    useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
    useSessionUIStore.setState(s => ({ newSessionDraft: { ...s.newSessionDraft, ...target } }));
    await sleep(0);
  });
  expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('a');
  expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(directory);
  expect(c.prompts()).toHaveLength(0);
});

for (const catalog of ['stock', 'managed'] as const) for (const explicit of [false, true]) test(`boot fallback during ${catalog} route discovery (explicit choice ${explicit})`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const held = deferred<void>();
  const refresh = spyOn(managedRefresh, 'refreshManagedProjects').mockImplementation(() => held.promise);
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
      useGlobalSessionsStore.getState().applySnapshot([session], [], 'ready');
      useSessionUIStore.setState(s => ({ currentSessionId: null, currentSessionDirectory: null,
        nativeDraftCreations: new Map(), newSessionDraft: { ...s.newSessionDraft, open: false } }));
      await sleep(0);
    });
    await act(async () => {
      window.history.replaceState(null, '', `/?session=${session.id}`);
      const host = document.createElement('div'); c.dom.container.appendChild(host);
      root = createRoot(host); root.render(<Router />);
      await sleep(0);
    });
    expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
    // Actual ChatContainer boot fallback while the parent router awaits discovery.
    // Actual mounted ChatInput then reconciles its initial, not-yet-loaded branch list.
    await act(async () => {
      useSessionUIStore.getState().openNewSessionDraft({ automatic: true });
      await sleep(0);
    });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(directory);
    expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
    if (explicit) {
      await act(async () => {
        useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: 'a', directoryOverride: directory }, { force: true });
        await sleep(0);
      });
      expect(readLastActiveSession(c.runtimeA)).toBeNull();
    }
    await act(async () => {
      if (catalog === 'stock') useProjectsStore.setState({ managedCatalogStatus: 'stock' });
      else {
        useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
        useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
      }
      held.resolve(); await sleep(0);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(explicit ? null : session.id);
    expect(new URL(window.location.href).searchParams.get('session')).toBe(explicit ? null : session.id);
    expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  } finally { held.resolve(); refresh.mockRestore(); }
});
