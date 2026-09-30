import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from '@/components/chat/composer/submit/__tests__/nativeComposer.fixture';
import { directory } from '@/sync/native-draft-fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import * as globalSessions from '@/stores/useGlobalSessionsStore';

for (const [path, name] of [
  ['@/components/session/DirectoryExplorerDialog', 'DirectoryExplorerDialog'],
  ['@/components/session/NewWorktreeDialog', 'NewWorktreeDialog'],
  ['@/apps/MobileDeleteWorktreeDialog', 'MobileDeleteWorktreeDialog'],
  ['@/apps/MobileProjectEditSurface', 'MobileProjectEditSurface'],
] as const) mock.module(path, () => ({ [name]: () => null }));
const git = { checkIsGitRepository: async () => false };
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git }) }));
const { MobileSessionsSheet } = await import('./MobileSessionsSheet');
// SAFETY: this is the SyncProvider's public global context, as in the adjacent managed consumer test.
const runtime = (globalThis as { __openchamber_sync_runtime_context__?: React.Context<unknown> }).__openchamber_sync_runtime_context__;
if (!runtime) throw new Error('Sync runtime context missing');
const RuntimeProvider = runtime.Provider;
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const requests: string[] = [];
function Consumer() {
  if (!mounted) return null;
  return <RuntimeProvider value={{ childStores: mounted.children, messageLoader: mounted.loader, runtimeKey: mounted.runtimeA,
    currentDirectory: { get: () => directory, subscribe: () => () => undefined } }}>
    <section data-personal-mobile><MobileSessionsSheet open variant="sidebar" onOpenChange={() => undefined} /></section>
  </RuntimeProvider>;
}
afterEach(async () => { await mounted?.dispose(); mounted = undefined; useHumanAuth.setState({ enabled: false }); requests.length = 0; });

test('human mobile follows shared defaults, ignores anonymous expansion and reveals only A after explicit open', async () => {
  const refresh = spyOn(globalSessions, 'refreshGlobalSessions').mockImplementation(async () => ({ activeSessions: [], archivedSessions: [] }));
  try {
    mounted = await mountedNativeComposer(false, undefined, <Consumer />);
    // Intercept only the authenticated preference IO; all selection, list and row rendering stay real.
    const original = globalThis.fetch;
    let owner = 'A';
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/api/config/sidebar-view')) {
        if (init?.method === 'PATCH') { requests.push(String(init.body)); return Response.json({}); }
        return Response.json({ owner: { issuer: 'test', subject: owner }, projects: {}, groups: {} });
      }
      return original(input, init);
    };
    try {
      await act(async () => {
        useProjectsStore.setState({ projects: [{ id: 'p', path: directory, label: 'Project P', sidebarCollapsed: true }],
          activeProjectId: 'p', managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
        useMobileSessionTreeStore.getState().setProjectExpanded('p', true);
        const rows = Array.from({ length: 12 }, (_, i) => ({ id: `row${i}`, directory, projectID: 'p', title: `Row ${i}`, version: '1', slug: `row${i}`, time: { created: 12 - i, updated: 12 - i } }));
        globalSessions.useGlobalSessionsStore.setState({ activeSessions: rows });
        useHumanAuth.setState({ enabled: true }); useAuthSessionStore.getState().markAuthenticated();
        mounted?.remount(); await sleep(0); await sleep(0);
      });
      const surface = () => mounted?.dom.container.querySelector('[data-personal-mobile]')?.textContent ?? '';
      expect(surface()).not.toContain('Row 11'); expect(surface()).not.toContain('Row 0'); expect(requests).toHaveLength(0);
      await act(async () => { useSessionUIStore.getState().setCurrentSession('row11', directory); await sleep(0); await sleep(0); });
      expect(surface()).toContain('Row 11'); expect(requests).toHaveLength(1); expect(JSON.parse(requests[0]).owner.subject).toBe('A');
      await act(async () => { useAuthSessionStore.getState().markReauthenticating(); owner = 'B'; useAuthSessionStore.getState().markAuthenticated(); await sleep(0); await sleep(0); });
      expect(surface()).not.toContain('Row 11'); expect(requests).toHaveLength(1);
    } finally { globalThis.fetch = original; }
  } finally { refresh.mockRestore(); }
});
