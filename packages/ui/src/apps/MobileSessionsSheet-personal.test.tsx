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
import { getPinnedSessionKey, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
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
let sheetOpen = true;
let changeSheetOpen: ((open: boolean) => void) | undefined;
let sheetVariant: 'drawer' | 'sidebar' = 'sidebar';
const requests: string[] = [];
function Consumer() {
  const [open, setOpen] = React.useState(true);
  changeSheetOpen = setOpen;
  if (!mounted) return null;
  return <RuntimeProvider value={{ childStores: mounted.children, messageLoader: mounted.loader, runtimeKey: mounted.runtimeA,
    currentDirectory: { get: () => directory, subscribe: () => () => undefined } }}>
    <section data-personal-mobile><MobileSessionsSheet open={open} variant={sheetVariant} onOpenChange={open => {
      sheetOpen = open;
      setOpen(open);
    }} /></section>
  </RuntimeProvider>;
}
afterEach(async () => {
  await mounted?.dispose(); mounted = undefined;
  useHumanAuth.setState({ enabled: false }); useSessionPinnedStore.getState().setIds(new Set()); requests.length = 0;
  sheetOpen = true; sheetVariant = 'sidebar'; changeSheetOpen = undefined;
});

for (const human of [false, true]) {
  for (const selectedIndex of [2, 9]) {
    test(`mobile drawer reopen keeps root ${selectedIndex + 1} visible and active (${human ? 'human' : 'anonymous'})`, async () => {
      const refresh = spyOn(globalSessions, 'refreshGlobalSessions').mockImplementation(async () => ({
        activeSessions: globalSessions.useGlobalSessionsStore.getState().activeSessions, archivedSessions: [],
      }));
      const originalFetch = globalThis.fetch;
      try {
        sheetVariant = 'drawer';
        mounted = await mountedNativeComposer(false, undefined, <Consumer />);
        globalThis.fetch = async (input, init) => {
          if (String(input).includes('/api/config/sidebar-view')) {
            if (init?.method === 'PATCH') { requests.push(String(init.body)); return Response.json({}); }
            return Response.json({ owner: { issuer: 'test', subject: 'reopen' }, projects: {}, groups: {} });
          }
          return originalFetch(input, init);
        };
        await act(async () => {
          useProjectsStore.setState({ projects: [{ id: 'p', path: directory, label: 'Project P', sidebarCollapsed: false }],
            activeProjectId: 'p', managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
          useMobileSessionTreeStore.getState().setProjectExpanded('p', true);
          const rows = Array.from({ length: 12 }, (_, i) => ({ id: `reopen${i}`, directory, projectID: 'p',
            title: `Reopen row ${i}`, version: '1', slug: `reopen${i}`, time: { created: 12 - i, updated: 12 - i } }));
          globalSessions.useGlobalSessionsStore.setState({ activeSessions: rows });
          useHumanAuth.setState({ enabled: human });
          if (human) useAuthSessionStore.getState().markAuthenticated();
          mounted?.remount(); await sleep(0); await sleep(0);
        });
        const surface = () => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
          if (!dialog) throw new Error('Actual mobile drawer missing');
          return dialog;
        };
        const row = () => Array.from(surface().querySelectorAll<HTMLElement>('[data-active-session]'))
          .find(node => node.textContent?.includes(`Reopen row ${selectedIndex}`));
        const choose = () => Array.from(surface().querySelectorAll('button'))
          .find(button => button.textContent?.includes(`Reopen row ${selectedIndex}`));
        expect(surface().textContent).not.toContain('Reopen row 9');
        if (selectedIndex >= 7) {
          const more = Array.from(surface().querySelectorAll('button')).find(button => button.textContent?.trim() === 'Show more sessions');
          if (!more) throw new Error('Initial Show more missing');
          await act(async () => { more.click(); await sleep(0); });
        }
        const button = choose();
        if (!button) throw new Error('Selected root missing before click');
        await act(async () => { button.click(); await sleep(0); await sleep(0); });
        expect(sheetOpen).toBe(false);
        expect(useSessionUIStore.getState().currentSessionId).toBe(`reopen${selectedIndex}`);
        expect(surface().getAttribute('aria-hidden')).toBe('true');
        if (human) expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
        const writesBeforeReopen = requests.length;
        await act(async () => { changeSheetOpen?.(true); await sleep(0); await sleep(0); });
        expect(surface().getAttribute('aria-hidden')).toBe('false');
        expect(surface().textContent).toContain(`Reopen row ${selectedIndex}`);
        expect(row()?.getAttribute('data-active-session')).toBe('true');
        expect(requests).toHaveLength(writesBeforeReopen);
        if (selectedIndex < 7) expect(surface().textContent).not.toContain('Reopen row 9');
        else {
          expect(surface().textContent).not.toContain('Show more sessions');
          const collapse = surface().querySelector<HTMLButtonElement>('button[aria-label="Collapse Project P"]');
          if (!collapse) throw new Error('Expanded project toggle missing');
          await act(async () => { collapse.click(); await sleep(0); });
          const expand = surface().querySelector<HTMLButtonElement>('button[aria-label="Expand Project P"]');
          if (!expand) throw new Error('Collapsed project toggle missing');
          await act(async () => { expand.click(); await sleep(0); });
          expect(surface().textContent).not.toContain('Reopen row 9');
        }
      } finally { refresh.mockRestore(); globalThis.fetch = originalFetch; }
    });
  }
}

test('mobile drawer manual page reset wins over an in-flight discovery refresh', async () => {
  const refresh = spyOn(globalSessions, 'refreshGlobalSessions').mockImplementation(async () => ({
    activeSessions: globalSessions.useGlobalSessionsStore.getState().activeSessions,
    archivedSessions: [],
  }));
  const originalCheckIsGitRepository = git.checkIsGitRepository;
  let resolveDiscovery: ((isGitRepository: boolean) => void) | undefined;
  git.checkIsGitRepository = async () => new Promise<boolean>((resolve) => { resolveDiscovery = resolve; });
  const originalFetch = globalThis.fetch;
  try {
    sheetVariant = 'drawer';
    mounted = await mountedNativeComposer(false, undefined, <Consumer />);
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/api/config/sidebar-view')) {
        if (init?.method === 'PATCH') { requests.push(String(init.body)); return Response.json({}); }
        return Response.json({ owner: { issuer: 'test', subject: 'refresh-reset' }, projects: {}, groups: {} });
      }
      return originalFetch(input, init);
    };
    await act(async () => {
      useProjectsStore.setState({ projects: [{ id: 'p', path: directory, label: 'Project P', sidebarCollapsed: false }],
        activeProjectId: 'p', managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
      useMobileSessionTreeStore.getState().setProjectExpanded('p', true);
      const rows = Array.from({ length: 12 }, (_, i) => ({ id: `refresh-reset${i}`, directory, projectID: 'p',
        title: `Refresh reset row ${i}`, version: '1', slug: `refresh-reset${i}`, time: { created: 12 - i, updated: 12 - i } }));
      globalSessions.useGlobalSessionsStore.setState({ activeSessions: rows });
      useSessionUIStore.getState().setCurrentSession('refresh-reset9', directory);
      mounted?.remount(); await sleep(0); await sleep(0);
    });
    if (!resolveDiscovery) throw new Error('Discovery did not start');
    const surface = () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
      if (!dialog) throw new Error('Actual mobile drawer missing');
      return dialog;
    };
    const button = (label: string) => Array.from(surface().querySelectorAll('button'))
      .find(candidate => candidate.textContent?.trim() === label);
    await act(async () => { button('Show more sessions')?.click(); await sleep(0); });
    expect(surface().textContent).toContain('Refresh reset row 9');
    await act(async () => { button('Show fewer sessions')?.click(); await sleep(0); });
    expect(surface().textContent).not.toContain('Refresh reset row 9');
    await act(async () => { resolveDiscovery?.(false); await sleep(0); await sleep(0); });
    expect(surface().textContent).not.toContain('Refresh reset row 9');
  } finally {
    git.checkIsGitRepository = originalCheckIsGitRepository;
    refresh.mockRestore(); globalThis.fetch = originalFetch;
  }
});

for (const human of [false, true]) {
  test(
    `mobile drawer search selection reopens on its page and stays active (${human ? 'signed-in with pins' : 'anonymous'})`,
    async () => {
      const refresh = spyOn(globalSessions, 'refreshGlobalSessions').mockImplementation(async () => ({
        activeSessions: globalSessions.useGlobalSessionsStore.getState().activeSessions,
        archivedSessions: [],
      }));
      const originalFetch = globalThis.fetch;
      try {
        sheetVariant = 'drawer';
        mounted = await mountedNativeComposer(false, undefined, <Consumer />);
        globalThis.fetch = async (input, init) => {
          if (String(input).includes('/api/config/sidebar-view')) {
            if (init?.method === 'PATCH') { requests.push(String(init.body)); return Response.json({}); }
            return Response.json({ owner: { issuer: 'test', subject: 'search-reopen' }, projects: {}, groups: {} });
          }
          return originalFetch(input, init);
        };
        const runtimeKey = mounted?.runtimeA;
        if (!runtimeKey) throw new Error('Runtime key missing');
        await act(async () => {
          useProjectsStore.setState({ projects: [{ id: 'p', path: directory, label: 'Project P', sidebarCollapsed: false }],
            activeProjectId: 'p', managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
          useMobileSessionTreeStore.getState().setProjectExpanded('p', true);
          const rows = Array.from({ length: 12 }, (_, i) => ({ id: `search${i}`, directory, projectID: 'p',
            title: `Search row ${i}`, version: '1', slug: `search${i}`, time: { created: 12 - i, updated: 12 - i } }));
          globalSessions.useGlobalSessionsStore.setState({ activeSessions: rows });
          useHumanAuth.setState({ enabled: human });
          if (human) {
            useAuthSessionStore.getState().markAuthenticated();
            const pinned = [getPinnedSessionKey(runtimeKey, directory, 'search0')];
            useSessionPinnedStore.getState().setIds(new Set(pinned.filter((key): key is string => key !== null)));
          }
          mounted?.remount(); await sleep(0); await sleep(0);
        });
        const surface = () => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
          if (!dialog) throw new Error('Actual mobile drawer missing');
          return dialog;
        };
        const input = surface().querySelector<HTMLInputElement>('input');
        if (!input || !mounted) throw new Error('Mobile search input missing');
        const setValue = Object.getOwnPropertyDescriptor(mounted.dom.window.HTMLInputElement.prototype, 'value')?.set;
        if (!setValue) throw new Error('Native input setter missing');
        await act(async () => {
          setValue.call(input, 'Search row 9');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(0);
        });
        const button = Array.from(surface().querySelectorAll('button'))
          .find(candidate => candidate.textContent?.includes('Search row 9'));
        if (!button) throw new Error('Search result missing before click');
        await act(async () => { button.click(); await sleep(0); await sleep(0); });
        expect(sheetOpen).toBe(false);
        expect(useSessionUIStore.getState().currentSessionId).toBe('search9');
        await act(async () => { changeSheetOpen?.(true); await sleep(0); await sleep(0); });
        const active = Array.from(surface().querySelectorAll<HTMLElement>('[data-active-session]'))
          .find(node => node.textContent?.includes('Search row 9'));
        expect(surface().textContent).toContain('Search row 9');
        expect(active?.getAttribute('data-active-session')).toBe('true');
      } finally { refresh.mockRestore(); globalThis.fetch = originalFetch; }
    },
  );
}

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
