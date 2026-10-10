import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { useRouter } from '@/hooks/useRouter';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as globalSessions from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
import { createSidebarOwnerFixture } from '@/lib/sidebar-owner-fixture.js';
import { SessionRevealEffect } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'https://ui.example.test/?session=A' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const fixture = await createSidebarOwnerFixture();
const fetch = spyOn(globalThis, 'fetch');
const node = (id: string): SessionNode => ({ session: { id, directory: `/root-${id}`, title: id,
  projectID: `p${id}`, version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const nodes = ['A', 'B', 'C'].map(node);
const groupKey = 'pB:worktree:B';
const sections = nodes.map(n => ({ project: { id: n.session.projectID }, groups: [{
  id: `worktree:${n.session.id}`, label: n.session.id, branch: null, description: null,
  isMain: false, worktree: null, directory: n.session.directory, sessions: [n],
} satisfies SessionGroup] }));
let root: Root | null = null;
let personal: ReturnType<typeof usePersonalSidebarView>;
let ownerStatus = 0;
function Page() {
  useRouter();
  personal = usePersonalSidebarView();
  return <SessionRevealEffect sections={sections} />;
}
const settle = () => act(async () => { await sleep(40); await sleep(0); });
const mount = async () => {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Page />)); await settle(); await settle();
};
const unmount = async () => { await act(async () => root?.unmount()); root = null; };
const receipt = () => getSafeSessionStorage().getItem(
  `oc.tabSession.v1:${JSON.stringify([getRuntimeKey(), fixture.baseURL, fixture.subjects[0]])}`);
const state = () => ({ selected: useSessionUIStore.getState().currentSessionId,
  url: win.location.search, receipt: receipt(), historyLength: win.history.length });
const select = async (id: string) => {
  await act(async () => useSessionUIStore.getState().setCurrentSession(id, `/root-${id}`)); await settle();
};
beforeEach(async () => {
  await unmount(); fixture.person(0); fixture.heldRead = undefined;
  fixture.readFailure = undefined; fixture.refuse = false;
  await fixture.seed(0, { pA: true, pB: true, pC: true }); fixture.requests = []; fixture.gets = 0;
  ownerStatus = 0; getSafeSessionStorage().clear();
  configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  fetch.mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/config/sidebar-view')) return Response.json([]);
    const response = await fixture.fetch(input, init);
    if (init?.method !== 'PATCH') ownerStatus = response.status;
    return response;
  });
  win.history.replaceState({}, '', '/?session=A');
  useProjectsStore.getState().applyManagedCatalog(nodes.map(n => ({ id: n.session.projectID, worktree: n.session.directory })));
  globalSessions.useGlobalSessionsStore.getState().applySnapshot(nodes.map(n => n.session), [], 'ready');
  useSessionUIStore.getState().setCurrentSession('A', '/root-A', 'restore');
});
afterAll(async () => {
  await unmount(); fetch.mockRestore(); await fixture.close(); useHumanAuth.setState({ enabled: false });
  configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

for (const pending of [true, false]) {
  test(pending ? 'non-initial superseded Back A recovers distinct B URL on same-ID reopen and exact-URL reload'
    : 'healthy settled Back A adds no history entry and B survives exact-URL reload', async () => {
    const held = fixture.gate();
    const push = spyOn(win.history, 'pushState');
    let releaseRead = false, heldCalls = 0;
    let load: ReturnType<typeof spyOn<typeof globalSessions, 'ensureGlobalSessionsLoaded'>> | undefined;
    try {
      await mount();
      const initial = state();
      const warmOwner = { gets: fixture.gets, status: ownerStatus };
      await select('C'); await settle();
      const settledC = state();
      const settledPushes = push.mock.calls.map(call => String(call[2]));
      const realLoad = globalSessions.ensureGlobalSessionsLoaded;
      if (pending) load = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementationOnce(async () => {
        heldCalls++;
        await held.promise; releaseRead = true;
        return realLoad();
      });
      // Happy DOM 18 back() performs document navigation, not same-document popstate.
      // Establish A -> C with actual router pushes, then simulate Back's address change
      // and dispatch the actual event to the still-mounted router. No copied route logic.
      await act(async () => {
        win.history.replaceState({}, '', `/${initial.url}`);
        win.dispatchEvent(new win.PopStateEvent('popstate'));
      });
      await settle();
      const back = { ...state(), heldCalls, releaseRead };
      await select('B');
      const selectedWhileHeld = { ...state(), releaseRead };
      if (pending) await act(async () => held.resolve());
      await settle(); await settle();
      load?.mockRestore(); load = undefined;
      const afterRelease = state();
      await select('B'); await settle();
      const afterReopen = state();
      await settle(); await settle();
      const afterRepeat = state();
      const allPushes = push.mock.calls.map(call => String(call[2]));
      await act(async () => { await setPersonalSidebarView({ projects: { pB: true }, groups: { [groupKey]: true } }); });
      await settle();
      const beforeReload = await fixture.stored(0);
      const exactReloadURL = win.location.href;
      const writes = fixture.requests.length;
      await unmount();
      // Same address and safe session storage; no fabricated receipt or reveal ticket.
      await mount(); await settle();
      const reload = { ...state(), sameURL: win.location.href === exactReloadURL,
        patches: fixture.requests.slice(writes), projectCollapsed: personal.projects.pB,
        groupCollapsed: personal.groups[groupKey] };
      const facts = { pending, navigation: 'URL replace + actual PopStateEvent (not real-browser Back)',
        initial, warmOwner, settledC, settledPushes, back, selectedWhileHeld, afterRelease,
        afterReopen, afterRepeat, allPushes, beforeReload, exactReloadURL, reload };
      console.log('SUPERSEDED_POPSTATE_URL', JSON.stringify(facts));
      // Log every failure fact, including reload selection, before any assertion.
      expect(initial.selected).toBe('A'); expect(initial.url).toBe('?session=A');
      expect(warmOwner).toEqual({ gets: 1, status: 200 });
      expect(settledC.selected).toBe('C'); expect(settledC.url).toBe('?session=C');
      expect(settledPushes).toEqual(['/?session=C']);
      expect(back.url).toBe('?session=A');
      expect(back.selected).toBe(pending ? 'C' : 'A');
      expect(back.heldCalls).toBe(pending ? 1 : 0); expect(back.releaseRead).toBe(false);
      expect(afterRelease.selected).toBe('B'); expect(afterReopen.receipt).toBe('B');
      expect(afterRepeat).toEqual(afterReopen);
      expect({ url: afterReopen.url, pushes: allPushes, reloadSelected: reload.selected })
        .toEqual({ url: '?session=B', pushes: ['/?session=C', '/?session=B'], reloadSelected: 'B' });
      expect(reload.sameURL).toBe(true); expect(reload.receipt).toBe('B');
      expect(reload.patches).toEqual([]);
      expect(reload.projectCollapsed).toBe(true); expect(reload.groupCollapsed).toBe(true);
    } finally {
      held.resolve(); load?.mockRestore(); push.mockRestore(); await unmount();
    }
  });
}

test('healthy settled Back to home retains A and adds no push on clearAbortPrompt', async () => {
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore.getState().setSettingsDialogOpen(false);
  useSessionUIStore.getState().setCurrentSession(null);
  useSessionUIStore.getState().clearAbortPrompt();
  win.history.replaceState({}, '', '/');
  const push = spyOn(win.history, 'pushState');
  let notifications = 0;
  let unsubscribe = () => {};
  try {
    await mount(); const initial = state();
    await select('A'); const settledA = state();
    await select('B'); const settledB = state();
    const selectionPushes = push.mock.calls.map(call => String(call[2]));
    // Simulator: URL replacement + actual PopStateEvent, not browser Forward-index proof.
    await act(async () => { win.history.replaceState({}, '', '/?session=A');
      win.dispatchEvent(new win.PopStateEvent('popstate')); });
    await settle(); await settle(); const backA = state();
    const settingsAlreadyClosed = !useUIStore.getState().isSettingsDialogOpen;
    await act(async () => { win.history.replaceState({}, '', '/');
      win.dispatchEvent(new win.PopStateEvent('popstate')); });
    await settle(); const home = state();
    unsubscribe = useSessionUIStore.subscribe(() => { notifications++; });
    await act(async () => useSessionUIStore.getState().clearAbortPrompt());
    await settle(); const afterUnrelated = state();
    const allPushes = push.mock.calls.map(call => String(call[2]));
    console.log('HOME_POPSTATE_URL', JSON.stringify({ navigation: 'URL replace + actual PopStateEvent (not browser Forward index)',
      initial, settledA, settledB, selectionPushes, backA, settingsAlreadyClosed, home, afterUnrelated, notifications, allPushes }));
    expect(initial.selected).toBeNull(); expect(initial.url).toBe('');
    expect(settledA.selected).toBe('A'); expect(settledA.url).toBe('?session=A');
    expect(settledB.selected).toBe('B'); expect(settledB.url).toBe('?session=B');
    expect(selectionPushes).toEqual(['/?session=A', '/?session=B']);
    expect(backA.selected).toBe('A'); expect(backA.url).toBe('?session=A');
    expect(settingsAlreadyClosed).toBe(true); expect(home.selected).toBe('A'); expect(home.url).toBe('');
    expect(notifications).toBe(1); expect(afterUnrelated.selected).toBe('A');
    expect({ url: afterUnrelated.url, pushes: allPushes }).toEqual({ url: '', pushes: selectionPushes });
  } finally { unsubscribe(); push.mockRestore(); await unmount(); }
});
