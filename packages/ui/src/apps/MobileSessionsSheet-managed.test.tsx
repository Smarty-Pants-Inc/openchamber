import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '@opencode-ai/sdk/v2/client';
// Reuse synthetic network/DOM, real stores/child manager and accepted extraContent seam.
import { mountedNativeComposer } from '@/components/chat/composer/submit/__tests__/nativeComposer.fixture';
import { directory } from '@/sync/native-draft-fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as globalSessions from '@/stores/useGlobalSessionsStore';

// Closed dialogs are not session consumers. Do not mock the sheet, row, membership,
// merge helper, live-session hook, child cache or global-session store.
for (const [path, name] of [
  ['@/components/session/DirectoryExplorerDialog', 'DirectoryExplorerDialog'],
  ['@/components/session/NewWorktreeDialog', 'NewWorktreeDialog'],
  ['@/apps/MobileDeleteWorktreeDialog', 'MobileDeleteWorktreeDialog'],
  ['@/apps/MobileProjectEditSurface', 'MobileProjectEditSurface'],
] as const) mock.module(path, () => ({ [name]: () => null }));
// The composer fixture omits runtime Git. This consumer needs its read-only repository probe.
const git = { checkIsGitRepository: async () => false };
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git }) }));
const { MobileSessionsSheet } = await import('./MobileSessionsSheet');
// Same published context seam as issue-2903-subagent-status-line-only.test.tsx.
const runtimeContext = (globalThis as {
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
}).__openchamber_sync_runtime_context__;
if (!runtimeContext) throw new Error('Sync runtime context missing');
const RuntimeProvider = runtimeContext.Provider;
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreRefresh: (() => void) | undefined;
afterEach(async () => {
  try { await mounted?.dispose(); }
  finally { mounted = undefined; restoreRefresh?.(); restoreRefresh = undefined; }
});
const settle = () => sleep(0);
const savedA = { id: 'a', path: directory, label: 'Project A' };
const savedB = { id: 'b', path: '/native-project-b', label: 'Project B' };
const row = (id: string, path: string, title: string): Session => ({
  id, directory: path, title, projectID: path === directory ? 'a' : 'b',
  version: '1', slug: id, time: { created: 1, updated: 2 },
});
const a = row('a-member', directory, 'authority old A');
const freshA = { ...a, title: 'authority fresh A' };
const missingA = row('a-missing', directory, 'authority missing A');
const b = row('b-retired', savedB.path, 'authority retired B');
const stableOwner = row('same-id-other-directory', directory, 'authority stable owner');
const wrongDirectory = { ...stableOwner, directory: savedB.path, title: 'authority wrong directory' };

function MobileConsumer() {
  if (!mounted) return null;
  return <RuntimeProvider value={{ childStores: mounted.children, messageLoader: mounted.loader,
    runtimeKey: mounted.runtimeA, currentDirectory: { get: () => directory, subscribe: () => () => undefined } }}>
    <section data-testid="actual-mobile-consumer">
      <MobileSessionsSheet open variant="sidebar" onOpenChange={() => undefined} />
    </section>
  </RuntimeProvider>;
}
const surface = () => {
  const node = mounted?.dom.container.querySelector<HTMLElement>('[data-testid="actual-mobile-consumer"]');
  if (!node) throw new Error('Actual mobile consumer missing');
  return node;
};
async function search() {
  // Real controlled search input: tests the flat search consumer, where rows in
  // retired directories otherwise remain observable even after project removal.
  const input = surface().querySelector('input');
  if (!input || !mounted) throw new Error('Mobile search input missing');
  const setValue = Object.getOwnPropertyDescriptor(mounted.dom.window.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Native input setter missing');
  await act(async () => {
    setValue.call(input, 'authority');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
  expect(input.value).toBe('authority');
  // Positive proof that React received the change, not just a mutated DOM value.
  expect(surface().querySelector('button[aria-label="Clear search"]')).not.toBeNull();
}

for (const scenario of ['missing same-directory ID', 'managed empty', 'retired B', 'stock positive'] as const) {
  test(`actual mobile consumer: ${scenario}; child cache and draft retained`, async () => {
    // Isolate refresh IO only; this suite neither implements nor tests global late-event repair.
    const refresh = spyOn(globalSessions, 'refreshGlobalSessions').mockImplementation(async () => ({
      activeSessions: globalSessions.useGlobalSessionsStore.getState().activeSessions,
      archivedSessions: globalSessions.useGlobalSessionsStore.getState().archivedSessions,
    }));
    restoreRefresh = () => refresh.mockRestore();
    const c = mounted = await mountedNativeComposer(false, undefined, <MobileConsumer />);
    const childA = c.children.ensureChild(directory, { bootstrap: false });
    const childB = c.children.ensureChild(savedB.path, { bootstrap: false });
    await act(async () => {
      useProjectsStore.setState({ projects: [savedA, savedB], activeProjectId: 'a',
        managedCatalogAdmitted: scenario !== 'stock positive',
        managedCatalogStatus: scenario === 'stock positive' ? 'stock' : 'ready',
        managedProjects: [savedA, savedB], managedRows: [
          { id: 'gateway-a', worktree: directory }, { id: 'gateway-b', worktree: savedB.path },
        ] });
      globalSessions.useGlobalSessionsStore.setState({ activeSessions: [a, b, stableOwner] });
      childA.setState({ status: 'complete', session: [freshA, missingA] });
      childB.setState({ status: 'complete', session: [b, wrongDirectory] });
      if (scenario === 'retired B') c.target('b', savedB.path);
      c.remount();
      await settle();
    });
    await c.replace('Retain my unsent draft');
    await search();
    expect(surface().textContent).toContain('authority fresh A');
    expect(surface().textContent).not.toContain('authority old A');
    const cachedA = childA.getState().session, cachedB = childB.getState().session;
    const beforeDraft = useSessionUIStore.getState().newSessionDraft;
    await act(async () => {
      if (scenario === 'managed empty') {
        useProjectsStore.setState({ managedProjects: [], managedRows: [], activeProjectId: null });
      } else if (scenario === 'retired B') {
        useProjectsStore.setState({ managedProjects: [savedA],
          managedRows: [{ id: 'gateway-a', worktree: directory }], activeProjectId: 'a' });
      }
      await settle();
    });
    const text = surface().textContent;
    if (scenario === 'stock positive') {
      expect(text).toContain('authority missing A');
      expect(text).toContain('authority retired B');
      expect(text).toContain('authority wrong directory'); // Existing stock overlay behavior.
    } else {
      expect(text).not.toContain('authority missing A');
      expect(text).not.toContain('authority wrong directory');
      if (scenario === 'managed empty') {
        expect(text).not.toContain('authority fresh A');
        expect(text).not.toContain('authority stable owner');
        expect(text).not.toContain('authority retired B');
      } else {
        expect(text).toContain('authority fresh A');
        expect(text).toContain('authority stable owner');
        if (scenario === 'retired B') expect(text).not.toContain('authority retired B');
      }
    }
    expect(childA.getState().session).toBe(cachedA);
    expect(childB.getState().session).toBe(cachedB);
    expect(useProjectsStore.getState().projects).toEqual([savedA, savedB]);
    expect(useSessionUIStore.getState().newSessionDraft).toEqual(beforeDraft);
    expect(c.text()).toBe('Retain my unsent draft');
    expect(c.prompts()).toHaveLength(0);
  });
}
