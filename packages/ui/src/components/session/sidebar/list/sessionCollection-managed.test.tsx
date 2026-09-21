import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import * as sync from '@/sync/sync-context';
import { ChildStoreManager } from '@/sync/child-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { installHookTestDom } from '../test-utils/testDom';
import { buildSidebarSessionProjection, projectSidebarCollection, useSessionProjectCollection } from './sessionCollection';

const a = '/managed-a', b = '/managed-b';
const session = (id: string, directory: string): Session => ({
  id, directory, slug: id, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 },
});
const globalA = session('global-a', a), globalB = session('global-b', b);
const archivedB = { ...session('archived-b', b), time: { created: 1, updated: 1, archived: 2 } };

test('managed projections exclude missing global IDs and never treat empty membership as a stock wildcard', () => {
  const input = { globalActiveSessions: [globalA, globalB, archivedB], liveSessions: [session('cached-a', a)],
    knownDirectories: new Set([a]), isVSCode: false, managed: true };
  expect(projectSidebarCollection(input).map(s => s.id)).toEqual(['global-a']);
  expect(buildSidebarSessionProjection({ ...input, pinnedSessionIds: new Set(), sessionOrderRanks: new Map() })
    .orderedSessions.map(s => s.id)).toEqual(['global-a']);
  expect(projectSidebarCollection({ ...input, knownDirectories: new Set() })).toEqual([]);
});

test('actual collection hook retires cached active/archived rows without deleting child state; stock gap filling survives', async () => {
  const initialGlobal = useGlobalSessionsStore.getState(), initialProjects = useProjectsStore.getState();
  const children = new ChildStoreManager();
  const child = children.ensureChild(a, { bootstrap: false });
  const cached = [session('cached-a', a), globalB];
  child.setState({ session: cached });
  const live = spyOn(sync, 'useAllLiveSessions').mockImplementation(() => child.getState().session);
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in collection proof'));
  const dom = installHookTestDom(), root = createRoot(dom.container);
  let knownDirectories = new Set([a, b]);
  let collection: ReturnType<typeof useSessionProjectCollection> | undefined;
  function Probe() {
    collection = useSessionProjectCollection({ knownDirectories, isVSCode: false, isVisible: true });
    return null;
  }
  try {
    useProjectsStore.setState({ managedCatalogAdmitted: true });
    useGlobalSessionsStore.getState().applySnapshot([globalA, globalB], [archivedB]);
    await act(async () => root.render(<Probe />));
    expect(collection?.sessions.map(s => s.id)).toEqual(['global-a', 'global-b']);
    expect(collection?.archivedSessions.map(s => s.id)).toEqual(['archived-b']);
    knownDirectories = new Set([a]);
    await act(async () => root.render(<Probe />));
    expect(collection?.sessions.map(s => s.id)).toEqual(['global-a']);
    expect(collection?.archivedSessions).toEqual([]);
    knownDirectories = new Set();
    await act(async () => {
      useGlobalSessionsStore.getState().applySnapshot([], []);
      root.render(<Probe />);
    });
    expect(collection?.sessions).toEqual([]);
    expect(collection?.orderedSessions).toEqual([]);
    expect(child.getState().session).toBe(cached);
    await act(async () => useProjectsStore.setState({ managedCatalogAdmitted: false }));
    expect(collection?.sessions.map(s => s.id)).toEqual(['cached-a', 'global-b']);
    expect(child.getState().session).toBe(cached);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    children.disposeAll(); live.mockRestore(); network.mockRestore(); dom.restore();
    useProjectsStore.setState(initialProjects, true); useGlobalSessionsStore.setState(initialGlobal, true);
  }
});
